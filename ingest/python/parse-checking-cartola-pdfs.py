#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse Santander Chile checking-account cartola PDFs into JSON and CSV.

Uses `pdftotext -layout` when text is readable, with each table row's SUCURSAL cell placed by
the PDF's word positions (PyMuPDF, `checking_table_rows`); otherwise Tesseract OCR via PyMuPDF
(CID-encoded PDFs saved from macOS often need OCR).

From repo root:
  npm run parse:checking-cartola-pdfs
  npm run import:checking-cartolas -w nw-tracker-ingest

Requires: poppler (`pdftotext`), tesseract (`brew install tesseract`), pymupdf in `ingest/python/.pdf_deps`:

  pip3 install pypdf pymupdf -t ingest/python/.pdf_deps
PDFs: `cfraser/cartolas-cuenta-corriente/`
Output:
  cfraser/checking-cartolas-from-pdf.json
  cfraser/checking-cartolas-from-pdf.csv
"""

from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
CFRASER_DIR = REPO_ROOT / "cfraser"
PDF_DEPS = SCRIPT_DIR / ".pdf_deps"
if PDF_DEPS.is_dir():
    sys.path.insert(0, str(PDF_DEPS))
sys.path.insert(0, str(SCRIPT_DIR))

from cartola_layout import (
    AmountColumnBounds,
    CartolaRowDateError,
    PdfCartolaRowDates,
    amounts_by_column,
    detect_checking_column_bounds,
    parse_checking_summary_totals,
    reconcile_cartola_movements,
    single_digit_amount_position,
)
from cartola_text import cartola_text
from ocr_tessdata import use_expected_tessdata
from statement_values import parse_clp_amount, parse_dd_mm_yy_to_iso

RE_AMOUNT = re.compile(r"\d{1,3}(?:\.\d{3})+")
RE_AMOUNT_FULL = re.compile(r"^\d{1,3}(?:\.\d{3})+$")
RE_MOVEMENT_LINE = re.compile(r"^(\d{2}/\d{2})\s+(.+)$")
RE_DATE_ONLY = re.compile(r"^\s*(\d{2}/\d{2})\s*$")
RE_PERIOD_PAIR = re.compile(
    r"CARTOLA\s+DESDE\s+HASTA.*?(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
    re.I | re.S,
)
RE_SALDO_ROW = re.compile(
    r"SALDO\s+INICIAL\s+DEPOSITOS\s+OTROS\s+ABONOS\s+CHEQUES\s+OTROS\s+CARGOS\s+IMPUESTOS\s+SALDO\s+FINAL\s+"
    r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)",
    re.I | re.S,
)
RE_SALDO_ROW_OCR = re.compile(
    r"SALDO\s+INICIAL\s+DEPOSITOS\s+OTROS\s+ABONOS\s+CHEQUES\s+OTROS\s+CARGOS\s+IMPUESTOS\s+SALDO\s+FINAL\s+"
    r"((?:\d{1,3}(?:\.\d{3})+\s+){6}\d{1,3}(?:\.\d{3})+)",
    re.I,
)


def movement_dedupe_key(
    occurred_on: str,
    amount_clp: int,
    description: str,
    document_no: str = "",
) -> tuple:
    return (occurred_on, amount_clp, description, (document_no or "").strip())

# OCR word x-positions (dpi=300, ~letter width).
OCR_CARGO_X_MAX = 450
OCR_ABONO_X_MAX = 530
OCR_SALDO_X_MIN = 530


def resolve_pdfs_dir() -> Path:
    env = os.environ.get("CFRASER_CHECKING_CARTOLA_PDFS_DIR", "").strip()
    if env:
        return Path(env).resolve()
    return CFRASER_DIR / "cartolas-cuenta-corriente"


def period_month_from_hasta(hasta_iso: str) -> str:
    return hasta_iso[:7]


def extract_pdf_text_pdftotext(pdf_path: Path) -> Optional[str]:
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        return None
    proc = subprocess.run(
        [pdftotext, "-layout", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout
    return None


def is_readable_cartola_text(text: str) -> bool:
    flat = re.sub(r"\s+", " ", text)
    return "DETALLE DE MOVIMIENTOS" in flat and bool(
        RE_PERIOD_PAIR.search(flat) or re.search(r"\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}", flat)
    )


def parse_period_and_saldos(flat: str) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[int], Optional[int], Optional[str]]:
    period_from: Optional[str] = None
    period_to: Optional[str] = None
    period_month: Optional[str] = None
    cartola_no: Optional[str] = None

    m = RE_PERIOD_PAIR.search(flat)
    if not m:
        m = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})", flat)
    if m:
        period_from = parse_dd_mm_yy_to_iso(m.group(1))
        period_to = parse_dd_mm_yy_to_iso(m.group(2))
        if period_to:
            period_month = period_month_from_hasta(period_to)

    cm = re.search(
        r"0323-M-C-00\s+(\d+)\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
        flat,
    )
    if cm:
        cartola_no = cm.group(1)
        if not period_from:
            period_from = parse_dd_mm_yy_to_iso(cm.group(2))
        if not period_to:
            period_to = parse_dd_mm_yy_to_iso(cm.group(3))
        if period_to and not period_month:
            period_month = period_month_from_hasta(period_to)

    saldo_inicial: Optional[int] = None
    saldo_final: Optional[int] = None
    sm = RE_SALDO_ROW.search(flat)
    if sm:
        saldo_inicial = parse_clp_amount(sm.group(1))
        saldo_final = parse_clp_amount(sm.group(7))
    else:
        sm2 = RE_SALDO_ROW_OCR.search(flat)
        if sm2:
            nums = RE_AMOUNT.findall(sm2.group(1))
            if len(nums) >= 7:
                saldo_inicial = parse_clp_amount(nums[0])
                saldo_final = parse_clp_amount(nums[6])

    return period_month, period_from, period_to, saldo_inicial, saldo_final, cartola_no


@dataclass
class Movement:
    occurred_on: str
    amount_clp: int
    branch: str
    description: str
    document_no: str = ""
    debit_clp: Optional[int] = None
    credit_clp: Optional[int] = None
    balance_clp: Optional[int] = None


@dataclass
class ParsedCartola:
    source_file: str
    period_month: str
    period_from: Optional[str]
    period_to: Optional[str]
    saldo_inicial_clp: Optional[int]
    saldo_final_clp: Optional[int]
    cartola_no: Optional[str] = None
    movements: List[Movement] = field(default_factory=list)
    parse_status: str = "ok"
    parse_error: Optional[str] = None
    extractor: str = ""


class CartolaColumnError(ValueError):
    """A DETALLE DE MOVIMIENTOS row whose cells cannot be placed in the header's columns."""


# One word as the PDF places it: (x0, y0, x1, y1, text), in points (PyMuPDF's `get_text("words")`).
PdfWord = Tuple[float, float, float, float, str]

RE_ROW_DATE_WORD = re.compile(r"\d{2}/\d{2}")
# The 2018–2021 PDFs print a row's date and branch as one word («02/01» glued to the branch name).
RE_GLUED_DATE_WORD = re.compile(r"(\d{2}/\d{2})(\S+)")
# Words of a line within this many points of the date word's vertical centre are on its row.
ROW_Y_TOLERANCE = 2.0


@dataclass(frozen=True)
class TableRow:
    """One DETALLE DE MOVIMIENTOS row as the PDF places it: its date, the words of its SUCURSAL
    column and the words after it, cut by position (`checking_table_rows`). `description_x` is
    where the first word after the branch starts (None when the row holds only its date).
    `before_amounts` are the words after the branch left of the amount columns, in x order;
    `document_no` is the one of them in the N° DCTO column (digits) and `description` the others,
    one space apart: the cells the xlsx prints for the row."""

    page: int
    dd_mm: str
    branch: str
    after_branch: str
    description_x: Optional[float] = None
    before_amounts: Tuple[str, ...] = ()
    description: str = ""
    document_no: str = ""

    def text(self) -> str:
        return " ".join(p for p in (self.dd_mm, self.branch, self.after_branch) if p)

    def is_date_only(self) -> bool:
        return not self.branch and not self.after_branch


class PdfDependencyError(RuntimeError):
    """PyMuPDF, which reads the PDF's word positions (and runs the OCR), is not installed."""


def import_fitz():
    try:
        import fitz  # type: ignore
    except ImportError as e:
        raise PdfDependencyError(
            f"PyMuPDF is required to read cartola PDFs: {e} (pip3 install pymupdf -t ingest/python/.pdf_deps)"
        ) from None
    return fitz


def _word_mid_y(w: PdfWord) -> float:
    return (w[1] + w[3]) / 2


def _table_header(words: List[PdfWord]) -> Optional[Tuple[PdfWord, PdfWord]]:
    """The SUCURSAL and DESCRIPCION labels of the table header (one line; the page head also prints
    «SUCURSAL:» above the account, on a line of its own)."""
    for suc in words:
        if suc[4] != "SUCURSAL":
            continue
        for desc in words:
            if desc[4] == "DESCRIPCION" and abs(_word_mid_y(desc) - _word_mid_y(suc)) <= ROW_Y_TOLERANCE:
                return suc, desc
    return None


# The header's two-line labels («CHEQUES Y OTROS / CARGOS») sit a little off the DESCRIPCION line.
HEADER_LABEL_Y_TOLERANCE = 4.0
# The N° DCTO cells start this close left of the label (the number is right-aligned under it).
DOCUMENT_X_TOLERANCE = 6.0
RE_DOCUMENT_WORD = re.compile(r"\d{4,10}")


def _header_columns(words: List[PdfWord], desc: PdfWord, source_file: str, page_no: int) -> Tuple[float, float]:
    """Where the N° DCTO column and the amount columns (CHEQUES Y OTROS CARGOS) start."""
    y = _word_mid_y(desc)
    near = [w for w in words if abs(_word_mid_y(w) - y) <= HEADER_LABEL_Y_TOLERANCE and w[0] > desc[2]]
    doc = next((w for w in sorted(near, key=lambda w: w[0]) if w[4] in ("N°", "Nº")), None)
    if doc is None:
        raise CartolaColumnError(f"{source_file}: page {page_no}: the table header prints no N° DCTO label")
    cheques = next((w for w in sorted(near, key=lambda w: w[0]) if w[4] == "CHEQUES" and w[0] > doc[2]), None)
    if cheques is None:
        raise CartolaColumnError(f"{source_file}: page {page_no}: the table header prints no CHEQUES Y OTROS CARGOS label")
    return doc[0] - DOCUMENT_X_TOLERANCE, cheques[0]


def _row_cells(rest: List[PdfWord], doc_x: float, amounts_x: float, where: str) -> Tuple[Tuple[str, ...], str, str]:
    """A row's words left of the amount columns, its document number (the digits word in the
    N° DCTO column) and its description (the other words, one space apart)."""
    before = [o for o in rest if o[0] < amounts_x]
    docs = [o for o in before if o[0] >= doc_x and RE_DOCUMENT_WORD.fullmatch(o[4])]
    if len(docs) > 1:
        raise CartolaColumnError(f"{where}: several numbers in the N° DCTO column ({', '.join(o[4] for o in docs)})")
    description = " ".join(o[4] for o in before if not docs or o is not docs[0])
    return tuple(o[4] for o in before), description, docs[0][4] if docs else ""


def _is_table_end(words: List[PdfWord], i: int) -> bool:
    text = words[i][4].upper()
    nxt = words[i + 1][4].upper() if i + 1 < len(words) else ""
    if text == "RESUMEN" and nxt == "DE":
        return True
    if text == "INFORMACION" and nxt == "DE":
        return True
    return text == "MENSAJES"


def _split_glued_dates(words: List[PdfWord]) -> List[PdfWord]:
    """A word that is a date glued to the branch becomes the two words, the branch placed where its
    first character falls (the cartola's font is fixed-pitch)."""
    out: List[PdfWord] = []
    for w in words:
        m = RE_GLUED_DATE_WORD.fullmatch(w[4])
        if m is None:
            out.append(w)
            continue
        pitch = (w[2] - w[0]) / len(w[4])
        split_x = w[0] + pitch * len(m.group(1))
        out.append((w[0], w[1], split_x, w[3], m.group(1)))
        out.append((split_x, w[1], w[2], w[3], m.group(2)))
    return out


# The description cells of one cartola start at one x; a row whose first word after the branch
# starts elsewhere has a branch word the SUCURSAL label's edge did not take (or a stray word).
DESCRIPTION_X_TOLERANCE = 1.0


def checking_table_rows(pages: List[List[PdfWord]], source_file: str) -> List[TableRow]:
    """
    Every DETALLE DE MOVIMIENTOS row of a cuenta corriente cartola, in reading order, with its
    SUCURSAL cell cut by position: the header labels are centred over their columns and the
    branch cell starts under or before the SUCURSAL label, so a word starting left of that label's
    right edge is the branch and the description starts at the first word right of it. Spacing
    plays no part (`pdftotext -layout` renders the October 2026 layout with one space between the
    two cells). Rows end where the table does (Resumen de Comisiones, INFORMACION DE…, MENSAJES),
    as in the layout reader; a table continued on the next page under its repeated header goes on
    there. Raises when a page prints the table title without its header, or when the description
    cells do not all start at one x.
    """
    rows: List[TableRow] = []
    for page_no, words in enumerate(pages, start=1):
        ordered = sorted(_split_glued_dates(words), key=lambda w: (round(_word_mid_y(w)), w[0]))
        header = _table_header(ordered)
        if header is None:
            if any(w[4].upper() == "DETALLE" for w in ordered):
                raise CartolaColumnError(
                    f"{source_file}: page {page_no} prints DETALLE DE MOVIMIENTOS without its "
                    "SUCURSAL / DESCRIPCION header"
                )
            continue
        suc, desc = header
        doc_x, amounts_x = _header_columns(ordered, desc, source_file, page_no)
        header_y = _word_mid_y(suc)
        end_y = None
        for i, w in enumerate(ordered):
            if _word_mid_y(w) > header_y + ROW_Y_TOLERANCE and _is_table_end(ordered, i):
                end_y = _word_mid_y(w)
                break
        for w in ordered:
            y = _word_mid_y(w)
            if y <= header_y + ROW_Y_TOLERANCE or (end_y is not None and y >= end_y - ROW_Y_TOLERANCE):
                continue
            if not RE_ROW_DATE_WORD.fullmatch(w[4]) or w[2] > suc[0]:
                continue
            cells = sorted(
                (o for o in ordered if o is not w and abs(_word_mid_y(o) - y) <= ROW_Y_TOLERANCE and o[0] >= w[2]),
                key=lambda o: o[0],
            )
            branch = [o[4] for o in cells if o[0] < suc[2]]
            rest = [o for o in cells if o[0] >= suc[2]]
            before, description, document_no = _row_cells(
                rest, doc_x, amounts_x, f"{source_file}: row «{w[4]} {' '.join(branch)}» (page {page_no})"
            )
            rows.append(
                TableRow(
                    page_no,
                    w[4],
                    " ".join(branch),
                    " ".join(o[4] for o in rest),
                    rest[0][0] if rest else None,
                    before,
                    description,
                    document_no,
                )
            )
        if end_y is not None:
            break
    starts = [r.description_x for r in rows if r.description_x is not None]
    if starts:
        # The x most description cells start at.
        column_x = max(starts, key=lambda x: sum(1 for o in starts if abs(o - x) <= DESCRIPTION_X_TOLERANCE))
        for r in rows:
            if r.description_x is not None and abs(r.description_x - column_x) > DESCRIPTION_X_TOLERANCE:
                raise CartolaColumnError(
                    f"{source_file}: row «{r.text()}» (page {r.page}): its text after the branch "
                    f"«{r.branch}» starts at x={r.description_x:.1f}, the DESCRIPCION column at x={column_x:.1f}"
                )
    return rows


def read_pdf_words(pdf_path: Path) -> List[List[PdfWord]]:
    """Each page's words with their positions (PyMuPDF)."""
    fitz = import_fitz()
    with fitz.open(str(pdf_path)) as doc:
        return [[(w[0], w[1], w[2], w[3], w[4]) for w in page.get_text("words")] for page in doc]


def split_branch_description(middle: str, row: TableRow, source_file: str) -> Tuple[str, str, str]:
    """Branch, description and document number of a movement line's text between date and amounts.
    The cells are the PDF's, placed by position (`TableRow`: SUCURSAL, DESCRIPCION, N° DCTO); the
    line's text must open with the branch and then hold the row's words left of the amounts, word
    for word. Raises otherwise."""
    middle = middle.rstrip()
    where = f"{source_file}: row «{row.text()}»"
    if not row.branch:
        raise CartolaColumnError(f"{where}: nothing in the SUCURSAL column")
    opening = re.match(
        r"\s*" + r"\s+".join(re.escape(t) for t in row.branch.split()) + r"(?:\s+|$)", middle
    )
    if opening is None:
        raise CartolaColumnError(
            f"{where}: the line «{' '.join(middle.split())}» does not open with the "
            f"SUCURSAL cell «{row.branch}»"
        )
    layout_words = middle[opening.end() :].split()
    if not row.description:
        raise CartolaColumnError(f"{where}: nothing in the DESCRIPCION column")
    if tuple(layout_words) != row.before_amounts:
        raise CartolaColumnError(
            f"{where}: the line's description «{' '.join(layout_words)}» is not the PDF row's "
            f"«{' '.join(row.before_amounts)}»"
        )
    return row.branch, row.description, row.document_no


def check_row_words(line: str, row: TableRow, source_file: str) -> None:
    """The layout line and the PDF row are one row: after the date, the same words in the same
    order (branch, description, document number, amounts, the day's saldo)."""
    m = RE_MOVEMENT_LINE.match(line.rstrip())
    layout_words = m.group(2).split() if m else []
    pdf_words = row.branch.split() + row.after_branch.split()
    if layout_words != pdf_words:
        raise CartolaColumnError(
            f"{source_file}: row {row.dd_mm} (page {row.page}): the layout line «{' '.join(layout_words)}» "
            f"and the PDF row «{' '.join(pdf_words)}» are not the same words"
        )


def movement_from_amounts(
    occurred_on: str,
    branch: str,
    description: str,
    document_no: str,
    cargo: Optional[int],
    abono: Optional[int],
    balance: Optional[int],
) -> List[Movement]:
    # Every reader stores a cell in the one shared reading (`cartola_text.py`).
    branch, description, document_no = cartola_text(branch), cartola_text(description), cartola_text(document_no)
    out: List[Movement] = []
    if cargo and cargo > 0:
        out.append(
            Movement(
                occurred_on=occurred_on,
                amount_clp=-cargo,
                branch=branch,
                description=description,
                document_no=document_no,
                debit_clp=cargo,
                credit_clp=None,
                balance_clp=balance,
            )
        )
    if abono and abono > 0:
        out.append(
            Movement(
                occurred_on=occurred_on,
                amount_clp=abono,
                branch=branch,
                description=description,
                document_no=document_no,
                debit_clp=None,
                credit_clp=abono,
                balance_clp=balance,
            )
        )
    return out


def parse_movement_line_layout(
    line: str,
    row_dates: PdfCartolaRowDates,
    bounds: AmountColumnBounds,
    row: TableRow,
    source_file: str,
) -> List[Movement]:
    m = RE_MOVEMENT_LINE.match(line.rstrip())
    if not m:
        return []

    occurred_on = row_dates.resolve(m.group(1), line)

    cargo, abono = amounts_by_column(line, bounds)
    if cargo is None and abono is None:
        return []

    first_amount_pos = next(
        (am.start() for am in RE_AMOUNT.finditer(line) if am.start() < bounds.saldo_min),
        len(line),
    )
    single_digit_pos = single_digit_amount_position(line, bounds)
    if single_digit_pos is not None:
        first_amount_pos = min(first_amount_pos, single_digit_pos)
    middle = line[m.end(1) : first_amount_pos].rstrip()
    branch, description, document_no = split_branch_description(middle, row, source_file)

    return movement_from_amounts(
        occurred_on, branch, description, document_no, cargo, abono, None
    )


def _table_lines(text: str) -> List[str]:
    """The layout lines of the DETALLE DE MOVIMIENTOS table, as both layout readers walk it."""
    out: List[str] = []
    in_table = False
    for raw_line in text.splitlines():
        upper = raw_line.upper()
        if "DETALLE DE MOVIMIENTOS" in upper:
            in_table = True
            continue
        if not in_table:
            continue
        if "RESUMEN DE COMISIONES" in upper or upper.strip().startswith("MENSAJES"):
            break
        out.append(raw_line.rstrip())
    return out


def layout_is_stacked(text: str, source_file: str) -> bool:
    """
    Whether `pdftotext -layout` stacked the table: each row's date on a line of its own, branch and
    description on the lines below (the 2018-06 → 2021-02 cartolas, whose PDF prints date and
    branch as one word). Stacked when every dated line of the table is only its date, single-line
    when none is (or the table has no rows); a mix raises.
    """
    dated = [line for line in _table_lines(text) if re.match(r"^\d{2}/\d{2}\b", line)]
    date_only = [line for line in dated if RE_DATE_ONLY.match(line)]
    if not date_only:
        return False
    if len(date_only) == len(dated):
        return True
    other = next(line for line in dated if not RE_DATE_ONLY.match(line))
    raise CartolaColumnError(
        f"{source_file}: rows «{date_only[0].strip()}» and «{' '.join(other.split())}»: the layout "
        "mixes date-only lines with single-line rows"
    )


def check_stacked_rows(text: str, table_rows: List[TableRow], source_file: str) -> None:
    """In a stacked cartola the layout's date lines are the PDF's rows, one to one and in order,
    and the lines under each date hold that row's characters (pdftotext reorders a wrapped
    description and can glue a document number to it, so the characters are compared as a
    multiset)."""
    groups: List[Tuple[str, List[str]]] = []
    for line in _table_lines(text):
        dm = RE_DATE_ONLY.match(line)
        if dm:
            groups.append((dm.group(1), []))
        elif groups:
            groups[-1][1].extend(line.split())
    dates = [d for d, _ in groups]
    pdf_dates = [r.dd_mm for r in table_rows]
    if dates != pdf_dates:
        raise CartolaColumnError(
            f"{source_file}: the layout's date lines ({', '.join(dates) or 'none'}) are not the PDF's "
            f"rows ({', '.join(pdf_dates) or 'none'})"
        )
    for (dd_mm, words), row in zip(groups, table_rows):
        pdf_words = row.branch.split() + row.after_branch.split()
        if sorted("".join(words)) != sorted("".join(pdf_words)):
            raise CartolaColumnError(
                f"{source_file}: row {dd_mm} (page {row.page}): the layout lines «{' '.join(words)}» "
                f"and the PDF row «{' '.join(pdf_words)}» are not the same words"
            )


def parse_multiline_checking_movements(
    text: str,
    row_dates: PdfCartolaRowDates,
    bounds: AmountColumnBounds,
    table_rows: List[TableRow],
    source_file: str,
) -> List[Movement]:
    """Parse stacked FECHA / SUCURSAL / DESCRIPCION rows (legacy single-page layout). The layout
    gives each row's date and amounts; its cells are the PDF's, placed by position (the k-th date
    line is the k-th `TableRow`, `check_stacked_rows`): pdftotext reorders a wrapped description
    and glues a document number to it."""
    movements: List[Movement] = []
    in_table = False
    pending_date: Optional[str] = None
    row_index = -1

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        upper = line.upper()
        if "DETALLE DE MOVIMIENTOS" in upper:
            in_table = True
            continue
        if not in_table:
            continue
        if "RESUMEN DE COMISIONES" in upper or upper.strip().startswith("MENSAJES"):
            break
        if not line.strip() or upper.startswith("FECHA") or "CHEQUES Y OTROS" in upper:
            continue

        dm = RE_DATE_ONLY.match(line)
        if dm:
            pending_date = row_dates.resolve(dm.group(1), line)
            row_index += 1
            continue
        if pending_date is None:
            continue

        cargo, abono = amounts_by_column(line, bounds)
        if cargo is None and abono is None:
            continue
        row = table_rows[row_index]
        if not row.description:
            raise CartolaColumnError(f"{source_file}: row «{row.text()}»: nothing in the DESCRIPCION column")
        movements.extend(
            movement_from_amounts(pending_date, row.branch, row.description, row.document_no, cargo, abono, None)
        )

    return movements


def parse_single_line_checking_movements(
    text: str,
    row_dates: PdfCartolaRowDates,
    bounds: AmountColumnBounds,
    table_rows: List[TableRow],
    source_file: str,
) -> List[Movement]:
    """One movement per dated layout line. The k-th dated line is the PDF's k-th table row
    (`checking_table_rows`), which places its SUCURSAL cell: date and words must agree
    (`check_row_words`), and every row must be a line."""
    movements: List[Movement] = []
    in_table = False
    consumed = 0
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        upper = line.upper()
        if "DETALLE DE MOVIMIENTOS" in upper:
            in_table = True
            continue
        if not in_table:
            continue
        if "RESUMEN DE COMISIONES" in upper or upper.strip().startswith("MENSAJES"):
            break
        m = RE_MOVEMENT_LINE.match(line)
        if not m:
            continue
        where = f"{source_file}: row «{' '.join(line.split())}»"
        if consumed >= len(table_rows):
            raise CartolaColumnError(f"{where}: the PDF places no table row for it")
        row = table_rows[consumed]
        consumed += 1
        if row.dd_mm != m.group(1):
            raise CartolaColumnError(
                f"{where}: the PDF's table row {consumed} is «{row.text()}» (page {row.page})"
            )
        check_row_words(line, row, source_file)
        for mv in parse_movement_line_layout(line, row_dates, bounds, row, source_file):
            movements.append(mv)
    if consumed < len(table_rows):
        extra = table_rows[consumed]
        raise CartolaColumnError(
            f"{source_file}: row «{extra.text()}» (page {extra.page}) has no layout line"
        )
    return movements


def parse_ocr_word_rows(
    words: List[Tuple[float, float, str]],
    row_dates: PdfCartolaRowDates,
) -> List[Movement]:
    rows: Dict[float, List[Tuple[float, str]]] = defaultdict(list)
    for y, x, w in words:
        rows[round(y, 1)].append((x, w))

    movements: List[Movement] = []
    seen = set()

    for y in sorted(rows):
        parts = sorted(rows[y], key=lambda t: t[0])
        tokens = [w for _x, w in parts]
        text = " ".join(tokens)
        if not re.match(r"^\d{2}/\d{2}\b", text):
            continue

        fecha_m = re.match(r"^(\d{2}/\d{2})", text)
        if not fecha_m:
            continue
        occurred_on = row_dates.resolve(fecha_m.group(1), text)

        amount_tokens: List[Tuple[float, str]] = [
            (x, w) for x, w in parts if RE_AMOUNT_FULL.match(w)
        ]
        doc_tokens = [
            w
            for x, w in parts
            if re.fullmatch(r"\d{4,10}", w) and x < OCR_CARGO_X_MAX - 50
        ]
        document_no = doc_tokens[0] if doc_tokens else ""

        cargo: Optional[int] = None
        abono: Optional[int] = None
        balance: Optional[int] = None
        for x, amt_s in amount_tokens:
            val = parse_clp_amount(amt_s)
            if val is None:
                continue
            if x >= OCR_SALDO_X_MIN:
                balance = val
            elif x < OCR_CARGO_X_MAX:
                cargo = val
            elif x < OCR_ABONO_X_MAX:
                abono = val

        middle_tokens: List[str] = []
        for x, w in parts:
            if w == fecha_m.group(1) or w in {document_no} or RE_AMOUNT_FULL.match(w):
                continue
            if re.fullmatch(r"\d{4,10}", w) and x < OCR_CARGO_X_MAX - 50:
                continue
            if x >= OCR_CARGO_X_MAX - 20:
                continue
            middle_tokens.append(w)

        branch = ""
        description = ""
        if middle_tokens:
            branch = middle_tokens[0].lstrip("|").strip()
            description = " ".join(middle_tokens[1:]).strip() if len(middle_tokens) > 1 else branch
            if branch.startswith("0.") and len(branch) <= 3:
                branch = "O." + branch[2:]

        for mv in movement_from_amounts(
            occurred_on, branch, description, document_no, cargo, abono, balance
        ):
            key = movement_dedupe_key(
                mv.occurred_on, mv.amount_clp, mv.description, mv.document_no
            )
            if key in seen:
                continue
            seen.add(key)
            movements.append(mv)

    return movements


def extract_pdf_text_ocr(pdf_path: Path) -> Tuple[str, List[Tuple[float, float, str]]]:
    fitz = import_fitz()
    use_expected_tessdata()
    if not shutil.which("tesseract"):
        raise RuntimeError(
            "Tesseract is required for CID-encoded cartola PDFs. Install: brew install tesseract"
        )

    page = fitz.open(str(pdf_path))[0]
    tp = page.get_textpage_ocr(dpi=300, full=True)
    words = [(round(w[1], 1), round(w[0], 1), w[4]) for w in tp.extractWORDS()]
    flat = re.sub(r"\s+", " ", " ".join(w[2] for w in words))
    return flat, words


def finalize_checking_cartola(
    source_file: str,
    period_month: str,
    period_from: str,
    period_to: str,
    flat: str,
    saldo_inicial: Optional[int],
    saldo_final: Optional[int],
    cartola_no: Optional[str],
    movements: List[Movement],
    extractor: str,
) -> ParsedCartola:
    summary = parse_checking_summary_totals(flat)
    if summary is None and movements:
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=saldo_inicial,
            saldo_final_clp=saldo_final,
            cartola_no=cartola_no,
            movements=movements,
            parse_status="error",
            parse_error="Could not parse INFORMACION DE CUENTA CORRIENTE summary totals",
            extractor=extractor,
        )
    if summary is not None:
        err = reconcile_cartola_movements(summary, movements)
        if err:
            return ParsedCartola(
                source_file=source_file,
                period_month=period_month,
                period_from=period_from,
                period_to=period_to,
                saldo_inicial_clp=summary.saldo_inicial_clp,
                saldo_final_clp=summary.saldo_final_clp,
                cartola_no=cartola_no,
                movements=movements,
                parse_status="error",
                parse_error=err,
                extractor=extractor,
            )
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=summary.saldo_inicial_clp,
            saldo_final_clp=summary.saldo_final_clp,
            cartola_no=cartola_no,
            movements=movements,
            parse_status="ok",
            parse_error=None,
            extractor=extractor,
        )
    if not movements:
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=saldo_inicial,
            saldo_final_clp=saldo_final,
            cartola_no=cartola_no,
            movements=[],
            parse_status="ok",
            parse_error=None,
            extractor=extractor,
        )
    return ParsedCartola(
        source_file=source_file,
        period_month=period_month,
        period_from=period_from,
        period_to=period_to,
        saldo_inicial_clp=saldo_inicial,
        saldo_final_clp=saldo_final,
        cartola_no=cartola_no,
        movements=movements,
        parse_status="error",
        parse_error="Could not parse INFORMACION DE CUENTA CORRIENTE summary totals",
        extractor=extractor,
    )


def row_date_error_cartola(
    source_file: str,
    period_month: str,
    period_from: str,
    period_to: str,
    cartola_no: Optional[str],
    error: CartolaRowDateError,
    extractor: str,
) -> ParsedCartola:
    return ParsedCartola(
        source_file=source_file,
        period_month=period_month,
        period_from=period_from,
        period_to=period_to,
        saldo_inicial_clp=None,
        saldo_final_clp=None,
        cartola_no=cartola_no,
        movements=[],
        parse_status="error",
        parse_error=str(error),
        extractor=extractor,
    )


def column_error_cartola(
    source_file: str,
    period_month: str,
    period_from: str,
    period_to: str,
    cartola_no: Optional[str],
    error: CartolaColumnError,
    extractor: str,
) -> ParsedCartola:
    return ParsedCartola(
        source_file=source_file,
        period_month=period_month,
        period_from=period_from,
        period_to=period_to,
        saldo_inicial_clp=None,
        saldo_final_clp=None,
        cartola_no=cartola_no,
        movements=[],
        parse_status="error",
        parse_error=str(error),
        extractor=extractor,
    )


def parse_cartola_text(
    text: str,
    source_file: str,
    extractor: str,
    table_rows: List[TableRow],
) -> ParsedCartola:
    """Parse one cartola's `pdftotext -layout` text. `table_rows` are the PDF's table rows placed by
    position (`checking_table_rows`); they decide the layout (`is_stacked_layout`)."""
    flat = re.sub(r"\s+", " ", text)
    period_month, period_from, period_to, saldo_inicial, saldo_final, cartola_no = (
        parse_period_and_saldos(flat)
    )
    if not period_month or not period_from or not period_to:
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month or "",
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=saldo_inicial,
            saldo_final_clp=saldo_final,
            cartola_no=cartola_no,
            movements=[],
            parse_status="error",
            parse_error="Could not parse CARTOLA DESDE/HASTA dates.",
            extractor=extractor,
        )

    movements: List[Movement] = []
    column_bounds = detect_checking_column_bounds(text)
    try:
        row_dates = PdfCartolaRowDates(source_file, period_from, period_to)
        if layout_is_stacked(text, source_file):
            check_stacked_rows(text, table_rows, source_file)
            movements = parse_multiline_checking_movements(
                text, row_dates, column_bounds, table_rows, source_file
            )
        else:
            movements = parse_single_line_checking_movements(
                text, row_dates, column_bounds, table_rows, source_file
            )
    except CartolaRowDateError as e:
        return row_date_error_cartola(
            source_file, period_month, period_from, period_to, cartola_no, e, extractor
        )
    except CartolaColumnError as e:
        return column_error_cartola(
            source_file, period_month, period_from, period_to, cartola_no, e, extractor
        )

    return finalize_checking_cartola(
        source_file,
        period_month,
        period_from,
        period_to,
        flat,
        saldo_inicial,
        saldo_final,
        cartola_no,
        movements,
        extractor,
    )


def parse_cartola_ocr(pdf_path: Path) -> ParsedCartola:
    flat, words = extract_pdf_text_ocr(pdf_path)
    period_month, period_from, period_to, saldo_inicial, saldo_final, cartola_no = (
        parse_period_and_saldos(flat)
    )
    if not period_month or not period_from or not period_to:
        return ParsedCartola(
            source_file=pdf_path.name,
            period_month=period_month or "",
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=saldo_inicial,
            saldo_final_clp=saldo_final,
            cartola_no=cartola_no,
            movements=[],
            parse_status="error",
            parse_error="Could not parse period dates from OCR.",
            extractor="ocr",
        )

    try:
        movements = parse_ocr_word_rows(
            words, PdfCartolaRowDates(pdf_path.name, period_from, period_to)
        )
    except CartolaRowDateError as e:
        return row_date_error_cartola(
            pdf_path.name, period_month, period_from, period_to, cartola_no, e, "ocr"
        )
    return finalize_checking_cartola(
        pdf_path.name,
        period_month,
        period_from,
        period_to,
        flat,
        saldo_inicial,
        saldo_final,
        cartola_no,
        movements,
        "ocr",
    )


def parse_pdf_file(pdf_path: Path) -> ParsedCartola:
    text = extract_pdf_text_pdftotext(pdf_path)
    if text and is_readable_cartola_text(text):
        try:
            table_rows = checking_table_rows(read_pdf_words(pdf_path), pdf_path.name)
        except CartolaColumnError as e:
            return ParsedCartola(
                source_file=pdf_path.name,
                period_month="",
                period_from=None,
                period_to=None,
                saldo_inicial_clp=None,
                saldo_final_clp=None,
                movements=[],
                parse_status="error",
                parse_error=str(e),
                extractor="pdftotext",
            )
        return parse_cartola_text(text, pdf_path.name, "pdftotext", table_rows)
    try:
        return parse_cartola_ocr(pdf_path)
    except PdfDependencyError:
        raise
    except Exception as e:
        return ParsedCartola(
            source_file=pdf_path.name,
            period_month="",
            period_from=None,
            period_to=None,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            movements=[],
            parse_status="unreadable",
            parse_error=str(e),
            extractor="",
        )


def cartola_to_dict(c: ParsedCartola) -> dict:
    d = asdict(c)
    d["movements"] = [asdict(m) for m in c.movements]
    return d


CSV_FIELDS = [
    "source_file",
    "period_month",
    "period_from",
    "period_to",
    "cartola_no",
    "saldo_inicial_clp",
    "saldo_final_clp",
    "occurred_on",
    "branch",
    "description",
    "document_no",
    "debit_clp",
    "credit_clp",
    "amount_clp",
    "balance_clp",
]


def write_cartolas_csv(cartolas: List[ParsedCartola], out_path: Path) -> None:
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for cartola in cartolas:
            if cartola.parse_status != "ok":
                continue
            base = {
                "source_file": cartola.source_file,
                "period_month": cartola.period_month,
                "period_from": cartola.period_from or "",
                "period_to": cartola.period_to or "",
                "cartola_no": cartola.cartola_no or "",
                "saldo_inicial_clp": cartola.saldo_inicial_clp or "",
                "saldo_final_clp": cartola.saldo_final_clp or "",
            }
            for mv in cartola.movements:
                writer.writerow(
                    {
                        **base,
                        "occurred_on": mv.occurred_on,
                        "branch": mv.branch,
                        "description": mv.description,
                        "document_no": mv.document_no,
                        "debit_clp": mv.debit_clp if mv.debit_clp is not None else "",
                        "credit_clp": mv.credit_clp if mv.credit_clp is not None else "",
                        "amount_clp": mv.amount_clp,
                        "balance_clp": mv.balance_clp if mv.balance_clp is not None else "",
                    }
                )


def parse_only_basenames(argv: list[str]) -> set[str] | None:
    for arg in argv:
        if arg.startswith("--only="):
            names = [n.strip() for n in arg.split("=", 1)[1].split(",") if n.strip()]
            return set(names) if names else None
    return None


def merge_cartola_json_entries(
    out_path: Path, new_cartolas: List[dict], *, only_mode: bool
) -> List[dict]:
    if not only_mode or not out_path.is_file():
        return list(new_cartolas)
    try:
        existing = json.loads(out_path.read_text(encoding="utf-8")).get("cartolas") or []
    except (OSError, json.JSONDecodeError):
        existing = []
    replaced = {str(c.get("source_file") or "") for c in new_cartolas}
    return [c for c in existing if str(c.get("source_file") or "") not in replaced] + new_cartolas


def main() -> int:
    only = parse_only_basenames(sys.argv)
    pdfs_dir = resolve_pdfs_dir()
    json_path = CFRASER_DIR / "checking-cartolas-from-pdf.json"
    csv_path = CFRASER_DIR / "checking-cartolas-from-pdf.csv"
    if not pdfs_dir.is_dir():
        print(f"No PDF directory: {pdfs_dir}", file=sys.stderr)
        return 1

    all_pdfs = sorted(pdfs_dir.glob("*.pdf"))
    if only is not None:
        pdfs = [p for p in all_pdfs if p.name in only]
        missing = sorted(only - {p.name for p in pdfs})
        for name in missing:
            print(f"  WARN --only missing PDF: {name}", file=sys.stderr)
    else:
        pdfs = all_pdfs
    if not pdfs:
        print(f"No PDFs to parse in {pdfs_dir}")
        return 0

    parsed_list: List[ParsedCartola] = []
    cartolas_json: List[dict] = []
    errors = 0
    for pdf in pdfs:
        try:
            parsed = parse_pdf_file(pdf)
        except PdfDependencyError as e:
            print(str(e), file=sys.stderr)
            return 2
        parsed_list.append(parsed)
        cartolas_json.append(cartola_to_dict(parsed))
        if parsed.parse_status != "ok":
            errors += 1
            print(f"  {pdf.name}: {parsed.parse_status} — {parsed.parse_error}", file=sys.stderr)
        else:
            print(
                f"  {pdf.name}: {parsed.period_month} [{parsed.extractor}] "
                f"({len(parsed.movements)} movements, saldo final {parsed.saldo_final_clp})"
            )

    merged_cartolas = merge_cartola_json_entries(
        json_path, cartolas_json, only_mode=only is not None
    )
    payload = {
        "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pdfs_dir": str(pdfs_dir),
        "cartolas": merged_cartolas,
    }
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if only is None:
        write_cartolas_csv(parsed_list, csv_path)
        print(f"Wrote {csv_path} ({sum(len(c.movements) for c in parsed_list if c.parse_status == 'ok')} movement rows)")
    else:
        print(f"Wrote {json_path} ({len(cartolas_json)} parsed, {len(merged_cartolas)} total cartola(s))")
    print(f"Wrote {json_path}")
    if errors:
        print(f"  {errors} cartola(s) not read; each is in the JSON with its reason", file=sys.stderr)
    # A cartola that does not parse fails only itself: its status is in the JSON, which the import
    # reports as unreadable. A non-zero exit means the run itself did not finish.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
