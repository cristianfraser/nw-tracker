#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse Santander CUENTAMATICA / cuenta vista cartola PDFs into JSON.

Uses `pdftotext -layout`. PDFs: `cfraser/cartolas-cuenta-vista/` (or `CFRASER_CUENTA_VISTA_PDFS_DIR`).

From repo root:
  npm run parse:cuenta-vista-cartola-pdfs
  npm run import:cuenta-vista-cartolas -w nw-tracker-server
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
CFRASER_DIR = REPO_ROOT / "cfraser"

RE_AMOUNT = re.compile(r"\d{1,3}(?:\.\d{3})+")
RE_PERIOD = re.compile(
    r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
)
RE_SALDO_SUMMARY = re.compile(
    r"Saldo\s+Inicial\s+Cheques\s+o\s+Cargos\s+Dep[óo]sitos\s+o\s+Saldo\s+Final\s+"
    r"(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*)\s+(\d{1,3}(?:\.\d{3})*)",
    re.I | re.S,
)
RE_DATE_LINE = re.compile(r"^\s*(\d{2}/\d{2})\b")
RE_DOC_PREFIX = re.compile(r"^\s*(\d{6,10})\s+")
RE_SUC = re.compile(r"^\s*(\d{2,3})\s+")
RE_SALDO_DIA = re.compile(r"---\s*Saldo\s+D[ií]a\s*---", re.I)

# pdftotext -layout: cargos left of ~125, abonos at ~131+
CARGO_COL_MAX = 125
ABONO_COL_MIN = 125


@dataclass
class ParsedMovement:
    occurred_on: str
    amount_clp: int
    branch: str
    description: str
    document_no: str


@dataclass
class ParsedCartola:
    source_file: str
    period_month: str
    period_from: Optional[str]
    period_to: Optional[str]
    saldo_inicial_clp: Optional[int]
    saldo_final_clp: Optional[int]
    movements: List[ParsedMovement] = field(default_factory=list)
    skipped: List[dict] = field(default_factory=list)
    parse_status: str = "ok"
    parse_error: Optional[str] = None
    extractor: str = "pdftotext-layout"


def resolve_pdfs_dir() -> Path:
    env = os.environ.get("CFRASER_CUENTA_VISTA_PDFS_DIR", "").strip()
    if env:
        return Path(env).resolve()
    return CFRASER_DIR / "cartolas-cuenta-vista"


def resolve_output_json() -> Path:
    return CFRASER_DIR / "cuenta-vista-cartolas-from-pdf.json"


def parse_clp_amount(raw: str) -> Optional[int]:
    t = str(raw or "").strip().replace(".", "")
    if not t:
        return None
    try:
        return int(t)
    except ValueError:
        return None


def dd_mm_yyyy_to_iso(raw: str) -> Optional[str]:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        date(y, mo, d)
    except ValueError:
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


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
    return f"{y:04d}-{mo:02d}-{d:02d}"


def amounts_by_column(line: str) -> Tuple[Optional[int], Optional[int]]:
    cargo: Optional[int] = None
    abono: Optional[int] = None
    for m in RE_AMOUNT.finditer(line):
        pos = m.start()
        val = parse_clp_amount(m.group())
        if val is None:
            continue
        if pos < CARGO_COL_MAX:
            cargo = val
        elif pos >= ABONO_COL_MIN:
            abono = val
    return cargo, abono


def strip_amounts_from_line(line: str) -> str:
    return RE_AMOUNT.sub("", line).strip()


def parse_description_line(
    line: str,
    current_date: Optional[str],
    desde_iso: str,
    hasta_iso: str,
) -> Tuple[Optional[str], Optional[ParsedMovement], Optional[dict]]:
    line = line.rstrip()
    if not line.strip():
        return current_date, None, None
    if RE_SALDO_DIA.search(line):
        return current_date, None, None
    if re.search(r"Resumen de Comisiones|MENSAJES|INFORMESE SOBRE", line, re.I):
        return current_date, None, {"reason": "end_of_table", "detail": line[:80]}

    work = line
    occurred_on = current_date
    document_no = ""

    dm = RE_DATE_LINE.match(work)
    if dm:
        dd_mm = dm.group(1)
        iso = dd_mm_to_iso(dd_mm, desde_iso, hasta_iso)
        if iso:
            occurred_on = iso
        work = work[dm.end() :].lstrip()

    if occurred_on is None:
        return current_date, None, None

    doc_m = RE_DOC_PREFIX.match(work)
    if doc_m:
        document_no = doc_m.group(1)
        work = work[doc_m.end() :].lstrip()

    branch = ""
    suc_m = RE_SUC.match(work)
    if suc_m:
        branch = suc_m.group(1)
        work = work[suc_m.end() :].lstrip()

    cargo, abono = amounts_by_column(line)
    if cargo is None and abono is None:
        return occurred_on, None, None

    description = strip_amounts_from_line(work)
    description = re.sub(r"\s+", " ", description).strip()
    if not description:
        return occurred_on, None, None

    if cargo is not None and abono is not None:
        return occurred_on, None, {
            "reason": "balance_mismatch",
            "detail": f"both cargo and abono on one line: {description[:60]}",
        }

    if cargo is not None:
        amount_clp = -cargo
    else:
        amount_clp = abono or 0

    if amount_clp == 0:
        return occurred_on, None, None

    return occurred_on, ParsedMovement(
        occurred_on=occurred_on,
        amount_clp=amount_clp,
        branch=branch or "—",
        description=description,
        document_no=document_no,
    ), None


def parse_cartola_pdf(pdf_path: Path) -> ParsedCartola:
    source_file = pdf_path.name
    try:
        text = subprocess.check_output(
            ["pdftotext", "-layout", str(pdf_path), "-"],
            stderr=subprocess.PIPE,
        ).decode("utf-8", errors="replace")
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        return ParsedCartola(
            source_file=source_file,
            period_month="",
            period_from=None,
            period_to=None,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            parse_status="error",
            parse_error=str(e),
        )

    if "CUENTAMATICA" not in text.upper() and "ESTADO CUENTAMATICA" not in text.upper():
        return ParsedCartola(
            source_file=source_file,
            period_month="",
            period_from=None,
            period_to=None,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            parse_status="unreadable",
            parse_error="Not a CUENTAMATICA cartola PDF",
        )

    period_from: Optional[str] = None
    period_to: Optional[str] = None
    pm = RE_PERIOD.search(text)
    if pm:
        period_from = dd_mm_yyyy_to_iso(pm.group(1))
        period_to = dd_mm_yyyy_to_iso(pm.group(2))
    if not period_to:
        return ParsedCartola(
            source_file=source_file,
            period_month="",
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            parse_status="error",
            parse_error="Could not parse cartola period (DESDE/HASTA)",
        )

    period_month = period_to[:7]
    saldo_inicial_clp: Optional[int] = None
    saldo_final_clp: Optional[int] = None
    sm = RE_SALDO_SUMMARY.search(text.replace("\n", " "))
    if sm:
        saldo_inicial_clp = parse_clp_amount(sm.group(1))
        saldo_final_clp = parse_clp_amount(sm.group(4))

    movements: List[ParsedMovement] = []
    skipped: List[dict] = []
    current_date: Optional[str] = None
    in_movements = False

    for raw_line in text.splitlines():
        if "MOVIMIENTO DE SU CUENTA" in raw_line.upper():
            in_movements = True
            continue
        if not in_movements:
            continue
        if re.search(r"Resumen de Comisiones|MENSAJES", raw_line, re.I):
            break

        current_date, mv, skip = parse_description_line(
            raw_line, current_date, period_from or period_to, period_to
        )
        if skip:
            skipped.append(skip)
        if mv is None:
            continue

        key = (mv.occurred_on, mv.amount_clp, mv.description, mv.document_no)
        if any(
            (m.occurred_on, m.amount_clp, m.description, m.document_no) == key
            for m in movements
        ):
            skipped.append({"reason": "duplicate_in_cartola", "detail": mv.description})
            continue
        movements.append(mv)

    if not movements:
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=saldo_inicial_clp,
            saldo_final_clp=saldo_final_clp,
            movements=[],
            skipped=skipped,
            parse_status="error",
            parse_error="No movements parsed",
        )

    return ParsedCartola(
        source_file=source_file,
        period_month=period_month,
        period_from=period_from,
        period_to=period_to,
        saldo_inicial_clp=saldo_inicial_clp,
        saldo_final_clp=saldo_final_clp,
        movements=movements,
        skipped=skipped,
        parse_status="ok",
    )


def main() -> int:
    pdfs_dir = resolve_pdfs_dir()
    out_path = resolve_output_json()
    pdfs = sorted(pdfs_dir.glob("*.pdf")) if pdfs_dir.is_dir() else []
    cartolas = [asdict(parse_cartola_pdf(p)) for p in pdfs]
    payload = {
        "generated_at": date.today().isoformat(),
        "pdfs_dir": str(pdfs_dir),
        "cartolas": cartolas,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(cartolas)} cartola(s) from {len(pdfs)} PDF(s)).")
    errors = [c for c in cartolas if c.get("parse_status") != "ok"]
    if errors:
        for c in errors:
            print(f"  WARN {c.get('source_file')}: {c.get('parse_error')}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
