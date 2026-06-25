#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse Santander Chile checking-account cartola PDFs into JSON and CSV.

Uses `pdftotext -layout` when text is readable; otherwise Tesseract OCR via PyMuPDF
(CID-encoded PDFs saved from macOS often need OCR).

From repo root:
  npm run parse:checking-cartola-pdfs
  npm run import:checking-cartolas -w nw-tracker-server -- --pdf

Requires: poppler (`pdftotext`), tesseract (`brew install tesseract`), pymupdf in `server/scripts/.pdf_deps`:

  pip3 install pypdf pymupdf -t server/scripts/.pdf_deps
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
from datetime import date, datetime
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
    RE_SMALL_INLINE,
    RE_SMALL_TRAILING,
    amounts_by_column,
    detect_checking_column_bounds,
    parse_checking_summary_totals,
    reconcile_cartola_movements,
    strip_amounts_from_line,
)

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
RE_DOC_IN_DESC = re.compile(r"^(\d{4,10})\s+(.+)$")


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


def tessdata_prefix() -> Optional[str]:
    env = os.environ.get("TESSDATA_PREFIX", "").strip()
    if env and Path(env).is_dir():
        return env
    for prefix in (
        "/opt/homebrew/share/tessdata",
        "/usr/local/share/tessdata",
        "/usr/share/tessdata",
    ):
        if Path(prefix).is_dir():
            return prefix
    return None


def parse_clp_amount(raw: str) -> Optional[int]:
    t = str(raw or "").strip().replace("$", "").strip()
    if not t:
        return None
    t = t.replace(".", "")
    try:
        return int(t)
    except ValueError:
        return None


def dd_mm_yyyy_to_iso(raw: str) -> Optional[str]:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if d < 1 or d > 31 or mo < 1 or mo > 12:
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def period_month_from_hasta(hasta_iso: str) -> str:
    return hasta_iso[:7]


def infer_movement_year(dd: int, mm: int, desde_iso: str, hasta_iso: str) -> int:
    d0 = date.fromisoformat(desde_iso)
    d1 = date.fromisoformat(hasta_iso)
    for y in (d0.year, d1.year, d0.year - 1, d1.year + 1):
        try:
            d = date(y, mm, dd)
        except ValueError:
            continue
        if d0 <= d <= d1:
            return y
    return d1.year


def dd_mm_to_iso(dd_mm: str, desde_iso: str, hasta_iso: str) -> Optional[str]:
    m = re.match(r"^(\d{1,2})/(\d{1,2})$", str(dd_mm or "").strip())
    if not m:
        return None
    d, mo = int(m.group(1)), int(m.group(2))
    y = infer_movement_year(d, mo, desde_iso, hasta_iso)
    if d < 1 or d > 31 or mo < 1 or mo > 12:
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


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
        period_from = dd_mm_yyyy_to_iso(m.group(1))
        period_to = dd_mm_yyyy_to_iso(m.group(2))
        if period_to:
            period_month = period_month_from_hasta(period_to)

    cm = re.search(
        r"0323-M-C-00\s+(\d+)\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
        flat,
    )
    if cm:
        cartola_no = cm.group(1)
        if not period_from:
            period_from = dd_mm_yyyy_to_iso(cm.group(2))
        if not period_to:
            period_to = dd_mm_yyyy_to_iso(cm.group(3))
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


def split_branch_description(middle: str) -> Tuple[str, str, str]:
    middle = middle.rstrip()
    doc = ""
    dm = RE_DOC_IN_DESC.match(middle.strip())
    if dm:
        doc = dm.group(1)
        middle = dm.group(2).strip()
    trailing_doc = re.search(r"\s(\d{6,10})\s*$", middle)
    if trailing_doc:
        doc = doc or trailing_doc.group(1)
        middle = middle[: trailing_doc.start()].rstrip()

    parts = re.split(r"\s{2,}", middle.strip(), maxsplit=1)
    if len(parts) == 1:
        tokens = parts[0].split()
        branch = tokens[0] if tokens else ""
        desc = parts[0]
    else:
        branch = parts[0].strip()
        desc = parts[1].strip()
    return branch, desc, doc


def movement_from_amounts(
    occurred_on: str,
    branch: str,
    description: str,
    document_no: str,
    cargo: Optional[int],
    abono: Optional[int],
    balance: Optional[int],
) -> List[Movement]:
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
    desde_iso: str,
    hasta_iso: str,
    bounds: AmountColumnBounds,
) -> List[Movement]:
    m = RE_MOVEMENT_LINE.match(line.rstrip())
    if not m:
        return []

    occurred_on = dd_mm_to_iso(m.group(1), desde_iso, hasta_iso)
    if not occurred_on:
        return []

    cargo, abono = amounts_by_column(line, bounds)
    if cargo is None and abono is None:
        return []

    first_amount_pos = next(
        (am.start() for am in RE_AMOUNT.finditer(line) if am.start() < bounds.saldo_min),
        len(line),
    )
    middle = line[m.end(1) : first_amount_pos].rstrip()
    branch, description, document_no = split_branch_description(middle)

    return movement_from_amounts(
        occurred_on, branch, description, document_no, cargo, abono, None
    )


def first_amount_position(line: str, bounds: AmountColumnBounds) -> int:
    positions = [
        m.start()
        for m in RE_AMOUNT.finditer(line)
        if m.start() < bounds.saldo_min
    ]
    for pat in (RE_SMALL_INLINE, RE_SMALL_TRAILING):
        sm = pat.search(line)
        if sm is not None:
            pos = sm.start(2 if pat is RE_SMALL_INLINE else 1)
            if pos < bounds.saldo_min:
                positions.append(pos)
    return min(positions) if positions else len(line)


def is_checking_branch_line(line: str, bounds: AmountColumnBounds) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 22:
        return False
    if RE_DATE_ONLY.match(line):
        return False
    cargo, abono = amounts_by_column(line, bounds)
    if cargo is not None or abono is not None:
        return False
    return bool(re.match(r"^[A-Z0-9][\w.]*(?:\s[\w.]+){0,2}$", stripped, re.I))


def split_document_from_description(text: str) -> Tuple[str, str]:
    cleaned = re.sub(r"\s+", " ", text.strip())
    if not cleaned:
        return "", ""
    dm = RE_DOC_IN_DESC.match(cleaned)
    if dm:
        return dm.group(1), dm.group(2).strip()
    trailing = re.search(r"\s(\d{6,10})\s*$", cleaned)
    if trailing:
        return trailing.group(1), cleaned[: trailing.start()].strip()
    return "", cleaned


def parse_multiline_checking_movements(
    text: str,
    desde_iso: str,
    hasta_iso: str,
    bounds: AmountColumnBounds,
) -> List[Movement]:
    """Parse stacked FECHA / SUCURSAL / DESCRIPCION rows (legacy single-page layout)."""
    movements: List[Movement] = []
    in_table = False
    pending_date: Optional[str] = None
    pending_branch = ""
    desc_parts: List[str] = []

    def emit_from_amount_line(line: str) -> None:
        nonlocal pending_date, pending_branch, desc_parts
        if pending_date is None:
            return
        cargo, abono = amounts_by_column(line, bounds)
        if cargo is None and abono is None:
            return

        prefix = strip_amounts_from_line(line[: first_amount_position(line, bounds)]).strip()
        parts = [p for p in desc_parts if p.strip()]
        document_no = ""
        if prefix:
            if re.fullmatch(r"\d{6,10}", prefix):
                document_no = prefix
            else:
                parts.append(prefix)

        document_no, description = split_document_from_description(" ".join(parts))
        if not description and document_no:
            description = f"Doc {document_no}"
            document_no = ""

        for mv in movement_from_amounts(
            pending_date,
            pending_branch,
            description,
            document_no,
            cargo,
            abono,
            None,
        ):
            movements.append(mv)
        desc_parts = []

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
        if not line.strip():
            continue
        if upper.startswith("FECHA") or "CHEQUES Y OTROS" in upper:
            continue

        dm = RE_DATE_ONLY.match(line)
        if dm:
            iso = dd_mm_to_iso(dm.group(1), desde_iso, hasta_iso)
            if iso:
                pending_date = iso
                pending_branch = ""
                desc_parts = []
            continue

        if pending_date is None:
            continue

        cargo, abono = amounts_by_column(line, bounds)
        if cargo is not None or abono is not None:
            emit_from_amount_line(line)
            continue

        if not pending_branch and is_checking_branch_line(line, bounds):
            pending_branch = line.strip()
            desc_parts = []
            continue

        stripped = line.strip()
        if stripped:
            desc_parts.append(stripped)

    return movements


def parse_single_line_checking_movements(
    text: str,
    desde_iso: str,
    hasta_iso: str,
    bounds: AmountColumnBounds,
) -> List[Movement]:
    movements: List[Movement] = []
    in_table = False
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
        if not RE_MOVEMENT_LINE.match(line):
            continue
        for mv in parse_movement_line_layout(line, desde_iso, hasta_iso, bounds):
            movements.append(mv)
    return movements


def parse_ocr_word_rows(
    words: List[Tuple[float, float, str]],
    desde_iso: str,
    hasta_iso: str,
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
        occurred_on = dd_mm_to_iso(fecha_m.group(1), desde_iso, hasta_iso)
        if not occurred_on:
            continue

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
    import fitz  # type: ignore

    prefix = tessdata_prefix()
    if prefix:
        os.environ.setdefault("TESSDATA_PREFIX", prefix)
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


def parse_cartola_text(text: str, source_file: str, extractor: str) -> ParsedCartola:
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
    movements = parse_single_line_checking_movements(
        text, period_from, period_to, column_bounds
    )
    if not movements:
        movements = parse_multiline_checking_movements(
            text, period_from, period_to, column_bounds
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

    movements = parse_ocr_word_rows(words, period_from, period_to)
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
        return parse_cartola_text(text, pdf_path.name, "pdftotext")
    try:
        return parse_cartola_ocr(pdf_path)
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
        parsed = parse_pdf_file(pdf)
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
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
