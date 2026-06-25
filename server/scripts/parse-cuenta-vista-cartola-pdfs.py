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
from typing import Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from cartola_pdf_kind import (
    is_checking_cartola_text,
    is_cuenta_vista_cartola_text,
    text_indicates_cartola_sin_movimientos,
)
from cartola_layout import (
    AmountColumnBounds,
    detect_vista_column_bounds,
    amounts_by_column,
    derive_month_saldo_final_clp,
    parse_vista_summary_totals,
    reconcile_cartola_movements,
    saldo_column_amount,
    strip_amounts_from_line,
    trim_spurious_flavia_credit,
)

CFRASER_DIR = REPO_ROOT / "cfraser"

RE_AMOUNT = re.compile(r"\d{1,3}(?:\.\d{3})+")
RE_PERIOD = re.compile(
    r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
)
RE_SALDO_DIA = re.compile(r"---\s*Saldo\s+D[ií]a\s*---", re.I)
RE_SIN_MOVIMIENTOS = re.compile(r"\*\*\s*CARTOLA\s+SIN\s+MOVIMIENTOS\s*\*\*", re.I)
RE_DATE_LINE = re.compile(r"^\s*(\d{2}/\d{2})\b")
RE_DOC_PREFIX = re.compile(r"^\s*(\d{6,10})\s+")
RE_SUC = re.compile(r"^\s*(\d{2,3})\s+")


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
    cartola_sin_movimientos: bool = False
    month_saldo_final_clp: Optional[Dict[str, int]] = None


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
    candidates: List[int] = []
    for y in (d0.year, d1.year, d0.year - 1, d1.year + 1):
        try:
            d = date(y, mm, dd)
        except ValueError:
            continue
        if d0 <= d <= d1:
            candidates.append(y)
    if not candidates:
        return d1.year
    if len(candidates) == 1:
        return candidates[0]
    return max(candidates)


def dd_mm_to_iso(dd_mm: str, desde_iso: str, hasta_iso: str) -> Optional[str]:
    m = re.match(r"^(\d{1,2})/(\d{1,2})$", str(dd_mm or "").strip())
    if not m:
        return None
    d, mo = int(m.group(1)), int(m.group(2))
    y = infer_movement_year(d, mo, desde_iso, hasta_iso)
    return f"{y:04d}-{mo:02d}-{d:02d}"


RE_COMPACT_VISTA_LINE = re.compile(
    r"^\s*(\d{4,10})\s+(\d{2}/\d{2})\s+(\d{1,3}(?:\.\d{3})+)\s+(\d+)\s+(.+)$"
)


def uses_compact_vista_layout(text: str) -> bool:
    return bool(re.search(r"Num\s+Doc\.\s+Fecha\s+Monto", text, re.I))


def parse_compact_vista_movements(
    text: str,
    period_from: str,
    period_to: str,
) -> Tuple[List[ParsedMovement], List[dict]]:
    movements: List[ParsedMovement] = []
    skipped: List[dict] = []
    section: Optional[str] = None
    in_table = False
    for raw_line in text.splitlines():
        if "MOVIMIENTO DE SU CUENTA" in raw_line.upper():
            in_table = True
            continue
        if not in_table:
            continue
        if re.search(r"Resumen de Comisiones", raw_line, re.I):
            break
        upper = raw_line.upper()
        if "CHEQUES O CARGOS" in upper or "SUC CHEQUES" in upper:
            section = "cargo"
            continue
        if "DEPOSITOS O ABONOS" in upper or "SUC DEPOSITOS" in upper:
            section = "abono"
            continue
        if RE_SIN_MOVIMIENTOS.search(raw_line) or RE_SALDO_DIA.search(raw_line):
            continue
        m = RE_COMPACT_VISTA_LINE.match(raw_line.rstrip())
        if not m or section is None:
            continue
        document_no, dd_mm, amt_raw, branch, description = m.groups()
        occurred_on = dd_mm_to_iso(dd_mm, period_from, period_to)
        amt = parse_clp_amount(amt_raw)
        if not occurred_on or amt is None:
            continue
        description = re.sub(r"\s+", " ", description).strip()
        amount_clp = -amt if section == "cargo" else amt
        movements.append(
            ParsedMovement(
                occurred_on=occurred_on,
                amount_clp=amount_clp,
                branch=branch or "—",
                description=description,
                document_no=document_no,
            )
        )
    return movements, skipped


def parse_description_line(
    line: str,
    current_date: Optional[str],
    desde_iso: str,
    hasta_iso: str,
    bounds: AmountColumnBounds,
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

    cargo, abono = amounts_by_column(line, bounds)
    if cargo is None and abono is None:
        return occurred_on, None, None

    description = strip_amounts_from_line(work)
    description = re.sub(r"\s+", " ", description).strip()
    if not description:
        return occurred_on, None, None
    if re.search(r"GRATIS\s+desde\s+red\s+fija|INFORMESE\s+SOBRE", description, re.I):
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


def finalize_vista_cartola(
    source_file: str,
    period_month: str,
    period_from: Optional[str],
    period_to: Optional[str],
    text: str,
    movements: List[ParsedMovement],
    skipped: List[dict],
    *,
    sin_movimientos: bool = False,
    saldo_dia: Optional[List[Tuple[str, int]]] = None,
) -> ParsedCartola:
    summary = parse_vista_summary_totals(text)
    sin_mov = sin_movimientos or bool(RE_SIN_MOVIMIENTOS.search(text))
    if summary is None and movements:
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            movements=movements,
            skipped=skipped,
            parse_status="error",
            parse_error="Could not parse cartola summary totals (Saldo Inicial / Cargos / Abonos / Final)",
        )
    if summary is not None:
        movements = trim_spurious_flavia_credit(summary, movements)
        err = reconcile_cartola_movements(summary, movements)
        if err:
            return ParsedCartola(
                source_file=source_file,
                period_month=period_month,
                period_from=period_from,
                period_to=period_to,
                saldo_inicial_clp=summary.saldo_inicial_clp,
                saldo_final_clp=summary.saldo_final_clp,
                movements=movements,
                skipped=skipped,
                parse_status="error",
                parse_error=err,
            )
        month_saldo_final_clp: Optional[Dict[str, int]] = None
        if saldo_dia:
            month_map, month_err = derive_month_saldo_final_clp(
                saldo_dia, movements, summary, period_from, period_to
            )
            if month_err:
                return ParsedCartola(
                    source_file=source_file,
                    period_month=period_month,
                    period_from=period_from,
                    period_to=period_to,
                    saldo_inicial_clp=summary.saldo_inicial_clp,
                    saldo_final_clp=summary.saldo_final_clp,
                    movements=movements,
                    skipped=skipped,
                    parse_status="error",
                    parse_error=month_err,
                )
            month_saldo_final_clp = month_map
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=summary.saldo_inicial_clp,
            saldo_final_clp=summary.saldo_final_clp,
            movements=movements,
            skipped=skipped,
            parse_status="ok",
            cartola_sin_movimientos=sin_mov and not movements,
            month_saldo_final_clp=month_saldo_final_clp,
        )
    if not movements and sin_mov:
        return ParsedCartola(
            source_file=source_file,
            period_month=period_month,
            period_from=period_from,
            period_to=period_to,
            saldo_inicial_clp=0,
            saldo_final_clp=0,
            movements=[],
            skipped=skipped,
            parse_status="ok",
            cartola_sin_movimientos=True,
        )
    return ParsedCartola(
        source_file=source_file,
        period_month=period_month,
        period_from=period_from,
        period_to=period_to,
        saldo_inicial_clp=None,
        saldo_final_clp=None,
        movements=movements,
        skipped=skipped,
        parse_status="error",
        parse_error="Could not parse cartola summary totals",
    )


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

    if is_checking_cartola_text(text):
        return ParsedCartola(
            source_file=source_file,
            period_month="",
            period_from=None,
            period_to=None,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            parse_status="skipped",
            parse_error="Checking cartola misfiled in cartolas-cuenta-vista (relocate to cartolas-cuenta-corriente)",
        )

    if not is_cuenta_vista_cartola_text(text):
        return ParsedCartola(
            source_file=source_file,
            period_month="",
            period_from=None,
            period_to=None,
            saldo_inicial_clp=None,
            saldo_final_clp=None,
            parse_status="unreadable",
            parse_error="Not a cuenta vista cartola PDF",
        )

    sin_movimientos = text_indicates_cartola_sin_movimientos(text)

    period_from: Optional[str] = None
    period_to: Optional[str] = None
    pm = RE_PERIOD.search(text)
    if pm:
        period_from = dd_mm_yyyy_to_iso(pm.group(1))
        period_to = dd_mm_yyyy_to_iso(pm.group(2))
    if not period_to:
        dates = re.findall(r"\b(\d{2}/\d{2}/\d{4})\b", text)
        if len(dates) >= 2:
            period_from = dd_mm_yyyy_to_iso(dates[-2])
            period_to = dd_mm_yyyy_to_iso(dates[-1])
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

    if uses_compact_vista_layout(text):
        movements, skipped = parse_compact_vista_movements(
            text, period_from or period_to, period_to
        )
        saldo_dia: List[Tuple[str, int]] = []
    else:
        column_bounds = detect_vista_column_bounds(text)
        movements = []
        skipped = []
        saldo_dia = []
        current_date: Optional[str] = None
        in_movements = False

        for raw_line in text.splitlines():
            if "MOVIMIENTO DE SU CUENTA" in raw_line.upper():
                in_movements = True
                continue
            if not in_movements:
                continue
            if re.search(r"Resumen de Comisiones", raw_line, re.I):
                break
            if "MOVIMIENTO DE SU CUENTA" in raw_line.upper():
                continue
            if re.match(r"^\s*FECHA\s", raw_line, re.I):
                continue
            upper = raw_line.upper()
            if ("CHEQUES" in upper and "DEPOSITOS" in upper) or (
                "CARGOS" in upper and "ABONOS" in upper and "CHEQUES" not in upper
            ):
                continue
            if RE_SIN_MOVIMIENTOS.search(raw_line):
                continue
            if RE_SALDO_DIA.search(raw_line):
                if current_date:
                    bal = saldo_column_amount(raw_line, column_bounds)
                    if bal is not None:
                        saldo_dia.append((current_date, bal))
                    else:
                        skipped.append(
                            {
                                "reason": "saldo_dia_no_amount",
                                "detail": raw_line.strip()[:80],
                            }
                        )
                continue

            current_date, mv, skip = parse_description_line(
                raw_line,
                current_date,
                period_from or period_to,
                period_to,
                column_bounds,
            )
            if skip:
                skipped.append(skip)
            if mv is None:
                continue
            movements.append(mv)

    return finalize_vista_cartola(
        source_file,
        period_month,
        period_from,
        period_to,
        text,
        movements,
        skipped,
        sin_movimientos=sin_movimientos,
        saldo_dia=saldo_dia,
    )


def parse_only_basenames(argv: list[str]) -> set[str] | None:
    for arg in argv:
        if arg.startswith("--only="):
            names = [n.strip() for n in arg.split("=", 1)[1].split(",") if n.strip()]
            return set(names) if names else None
    return None


def merge_cartola_json(
    out_path: Path, new_cartolas: list[dict], *, only_mode: bool
) -> list[dict]:
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
    out_path = resolve_output_json()
    all_pdfs = sorted(pdfs_dir.glob("*.pdf")) if pdfs_dir.is_dir() else []
    if only is not None:
        pdfs = [p for p in all_pdfs if p.name in only]
        missing = sorted(only - {p.name for p in pdfs})
        for name in missing:
            print(f"  WARN --only missing PDF: {name}", file=sys.stderr)
    else:
        pdfs = all_pdfs
    cartolas = [asdict(parse_cartola_pdf(p)) for p in pdfs]
    merged_cartolas = merge_cartola_json(out_path, cartolas, only_mode=only is not None)
    payload = {
        "generated_at": date.today().isoformat(),
        "pdfs_dir": str(pdfs_dir),
        "cartolas": merged_cartolas,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"Wrote {out_path} ({len(cartolas)} parsed, {len(merged_cartolas)} total cartola(s) from {len(pdfs)} PDF(s))."
    )
    for c in cartolas:
        status = c.get("parse_status")
        if status == "ok":
            continue
        level = "WARN" if status in ("skipped", "unreadable") else "ERROR"
        print(
            f"  {level} {c.get('source_file')}: {c.get('parse_error') or status}",
            file=sys.stderr,
        )
    hard_errors = [c for c in cartolas if c.get("parse_status") == "error"]
    return 1 if hard_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
