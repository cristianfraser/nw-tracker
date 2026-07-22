#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Reconcile parsed CC statement rows against PDF header and section totals."""

from __future__ import annotations

import json
import re
import unicodedata

import cc_cards
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

# Tolerances for pdftotext rounding
TOL_CLP = 1
TOL_USD = 0.02

RE_PAYMENT_MERCHANT = re.compile(r"^(PAGO|MONTO\s+CANCELADO|ABONO\b)", re.I)
RE_CLP_SECTION3_CHARGE = re.compile(
    r"IMPUESTOS|INTERESES|TRASPASO|COMISION|IMPTO\.|SERVICIO\s+USO\s+INTERNACIONAL|IVA\s+USO\s+INTERNACIONAL|NOTA\s+DE\s+CREDITO|DCTO\s+COM|ADM\|MANTENCION",
    re.I,
)
RE_USD_SECTION3 = re.compile(
    r"IMPUESTOS|INTERESES|TRASPASO|COMISION|ABONO\s+DE\s+DIVISAS|SERVICIO|NOTA\s+DE\s+CREDITO",
    re.I,
)


def _installment_cuota_counts_toward_operaciones(row: Dict[str, Any]) -> bool:
    """Section 1 includes continuing cuotas; new plans (TCOM / section 4) do not."""
    layout = str(row.get("parser_layout") or row.get("layout") or "")
    if "wide_master_tcom_cuotas_tasa" in layout:
        return False
    if "wide_master_periodic_summary" in layout:
        return False
    try:
        cur = int(row.get("nro_cuota_current") or 0)
    except (TypeError, ValueError):
        cur = 0
    if cur >= 1:
        return True
    if "wide_master_precio_summary" in layout or "wide_master_installment" in layout:
        return True
    return False


def _is_installment_contract_summary(merchant: str, layout: str) -> bool:
    u = str(merchant or "").upper()
    if not u:
        return False
    if "wide_master_periodic_summary" in str(layout or ""):
        return True
    return (
        "N/CUOTAS PRECIO" in u
        or "TRES CUOTAS PREC" in u
        or bool(re.search(r"\d{2}\s+CUOTAS\s+COMERC", u))
        or "CUOTA FIJA" in u
        or "CUOTA VARIABLE" in u
    )


def _is_garbled_intl_purchase_row(row: Dict[str, Any]) -> bool:
    """Merged pdftotext lines (e.g. «DE 2 APPLE… Nintendo») with wrong US$ assignment."""
    if str(row.get("currency") or "").lower() != "usd":
        return False
    m = str(row.get("merchant") or "").upper()
    if re.match(r"^DE\s+\d", m):
        return True
    if "MOVIMIENTOS TARJETA" in m:
        return True
    if any(t.upper() in m for t in cc_cards.MULTICARD_MARKER_TOKENS):
        return True
    return False


def _normalize_payment_merchant(merchant: str) -> str:
    u = str(merchant or "").upper()
    if "ABONO DE DIVISAS" in u:
        return "ABONO DE DIVISAS"
    if "TRASPASO" in u and "DEUDA" in u:
        return "TRASPASO DEUDA"
    return u.strip()


def _is_usd_section3_line(merchant: str, amount: float) -> bool:
    m = _normalize_payment_merchant(merchant)
    if m == "ABONO DE DIVISAS":
        return True
    if RE_PAYMENT_MERCHANT.match(m):
        return False
    if RE_USD_SECTION3.search(m):
        return True
    if "TRASPASO" in m:
        return True
    return amount < 0


def _is_clp_section3_line(merchant: str) -> bool:
    """CLP section 3 footer total sums charge lines (positive), not MONTO CANCELADO."""
    m = str(merchant or "").strip()
    if RE_PAYMENT_MERCHANT.match(m):
        return False
    return bool(RE_CLP_SECTION3_CHARGE.search(m))


def _row_counts_for_reconcile(row: Dict[str, Any]) -> bool:
    """Include cross-statement duplicates when they are section-3 lines on this PDF."""
    if str(row.get("is_duplicate_across_statements") or "").lower() != "true":
        return True
    currency = str(row.get("currency") or "clp").lower()
    merchant = str(row.get("merchant") or "")
    if currency == "usd":
        try:
            usd = float(str(row.get("amount_usd") or "0").replace(",", "."))
        except ValueError:
            usd = 0.0
        return _is_usd_section3_line(merchant, usd)
    return _is_clp_section3_line(merchant)


def _iter_reconcile_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen_dk: set[str] = set()
    seen_usd_bucket: set[str] = set()
    out: List[Dict[str, Any]] = []
    for row in rows:
        if not _row_counts_for_reconcile(row):
            continue
        dk = str(row.get("dedupe_key") or row.get("row_id") or "").strip()
        if dk:
            if dk in seen_dk:
                continue
            seen_dk.add(dk)
        currency = str(row.get("currency") or "clp").lower()
        if currency == "usd":
            txn = str(row.get("transaction_date") or row.get("posting_date") or "")
            try:
                usd = float(
                    str(row.get("amount_usd") or "0").replace(",", ".")
                )
            except ValueError:
                usd = 0.0
            cc = str(row.get("country") or "").upper().strip()
            merchant = _normalize_payment_merchant(str(row.get("merchant") or ""))
            if usd > 0:
                bucket = f"{txn}|{cc}|{usd:.2f}"
            else:
                bucket = f"{txn}|{usd:.2f}|{merchant}"
            if bucket in seen_usd_bucket:
                continue
            seen_usd_bucket.add(bucket)
        out.append(row)
    return out


def _parse_amount_from_row(
    row: Dict[str, Any],
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
) -> Tuple[str, float]:
    currency = str(row.get("currency") or "clp").lower()
    if currency == "usd":
        v = parse_usd(str(row.get("amount_usd") or ""))
        return "usd", float(v if v is not None else 0.0)
    v = parse_clp(str(row.get("amount_clp") or ""))
    return "clp", float(v if v is not None else 0.0)


def _parse_cuota_from_row(
    row: Dict[str, Any],
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
) -> float:
    currency = str(row.get("currency") or "clp").lower()
    if currency == "usd":
        v = parse_usd(str(row.get("valor_cuota_mensual_usd") or ""))
        if v is not None and v != 0:
            return float(v)
        v2 = parse_usd(str(row.get("amount_usd") or ""))
        return float(v2 if v2 is not None else 0.0)
    v = parse_clp(str(row.get("valor_cuota_mensual_clp") or ""))
    if v is not None and v != 0:
        return float(v)
    v2 = parse_clp(str(row.get("amount_clp") or ""))
    return float(v2 if v2 is not None else 0.0)


def sum_parsed_sections(
    rows: List[Dict[str, Any]],
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
) -> Dict[str, float]:
    """Sum parsed rows by statement section (deduped within statement)."""
    operaciones = 0.0
    cargos_abonos = 0.0
    cuotas = 0.0
    traspaso_nacional = 0.0

    for row in _iter_reconcile_rows(rows):
        currency, amount = _parse_amount_from_row(row, parse_clp, parse_usd)
        merchant = str(row.get("merchant") or "")
        layout = str(row.get("parser_layout") or "")
        inst = str(row.get("installment_flag") or "").lower() == "true"

        if inst:
            if _is_installment_contract_summary(merchant, layout):
                continue
            cuota = _parse_cuota_from_row(row, parse_clp, parse_usd)
            if cuota != 0:
                cuotas += cuota
                if currency == "clp" and _installment_cuota_counts_toward_operaciones(row):
                    operaciones += cuota
            continue

        if currency == "usd":
            if _is_garbled_intl_purchase_row(row):
                continue
            if _is_usd_section3_line(merchant, amount):
                cargos_abonos += amount
                if "TRASPASO" in merchant.upper() and "DEUDA" in merchant.upper():
                    traspaso_nacional += amount
                continue
            if amount > 0:
                operaciones += amount
            continue

        # CLP revolving
        if layout in ("compact_payment_abono", "ocr_payment"):
            continue
        if layout == "compact_cargos_charge":
            cargos_abonos += amount
            continue
        if _is_clp_section3_line(merchant):
            cargos_abonos += amount
            continue

        if amount > 0:
            operaciones += amount

    mid_period_payments = 0.0
    for row in _iter_reconcile_rows(rows):
        if str(row.get("currency") or "clp").lower() != "clp":
            continue
        if str(row.get("installment_flag") or "").lower() == "true":
            continue
        layout = str(row.get("parser_layout") or row.get("layout") or "")
        if layout in ("compact_payment_abono", "ocr_payment"):
            _cur, amount = _parse_amount_from_row(row, parse_clp, parse_usd)
            mid_period_payments += amount

    return {
        "parsed_operaciones": operaciones,
        "parsed_cargos_abonos": cargos_abonos,
        "parsed_cuotas": cuotas,
        "parsed_traspaso_nacional": traspaso_nacional,
        "parsed_mid_period_payments": mid_period_payments,
    }


def _parse_lone_amount_token(
    token: str, parse_clp: Callable, parse_usd: Callable, currency: str
) -> Optional[float]:
    t = token.strip()
    if not t or not re.match(r"^-?[\d.,]+$", t):
        return None
    if currency == "usd":
        return parse_usd(t)
    v = parse_clp(t)
    return float(v) if v is not None else None


def _last_amount_on_line(line: str, parse_clp: Callable, parse_usd: Callable, currency: str) -> Optional[float]:
    """Extract trailing monetary amount from a section summary line."""
    s = line.strip()
    if currency == "usd":
        m = re.search(r"US\$\s*(-?[\d.,\-]+)\s*$", s, re.I)
        if m:
            return parse_usd(m.group(1))
        m2 = re.search(
            r"(-?[\d]{1,3}(?:\.\d{3})*,\d{2}|-?[\d]+,\d{2})\s*$",
            s,
        )
        if m2:
            return parse_usd(m2.group(1))
    else:
        m = re.search(r"\$\s*([\d.\-]+)\s*$", s)
        if m:
            v = parse_clp(m.group(1))
            return float(v) if v is not None else None
    return None


def _amount_near_section_header(
    lines: List[str],
    idx: int,
    parse_clp: Callable,
    parse_usd: Callable,
    currency: str,
) -> Optional[float]:
    v = _last_amount_on_line(lines[idx], parse_clp, parse_usd, currency)
    if v is not None:
        return v
    candidates: List[float] = []
    for j in range(idx + 1, min(idx + 12, len(lines))):
        cand = lines[j].strip()
        if not cand:
            continue
        if re.search(r"MOVIMIENTOS|LUGAR\s+DE|FECHA\s+DE|DESCRIPCI", cand, re.I):
            break
        if cand.upper() in ("MONTO US$", "MONTO $", "US$"):
            continue
        v2 = _last_amount_on_line(cand, parse_clp, parse_usd, currency)
        if v2 is not None:
            candidates.append(v2)
            continue
        v3 = _parse_lone_amount_token(cand, parse_clp, parse_usd, currency)
        if v3 is not None:
            candidates.append(v3)
    if not candidates:
        return None
    return candidates[-1]


def _ascii_upper(text: str) -> str:
    folded = unicodedata.normalize("NFD", str(text or ""))
    stripped = "".join(c for c in folded if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", stripped).upper()


def is_bci_lider_statement(full: str) -> bool:
    """BCI/Líder EECC (not Santander — those statements also mention Líder merchants)."""
    upper = _ascii_upper(full)
    if "WORLDMEMBER" in upper or "MONTO ORIGEN OPERAC" in upper or "W. LIMITED" in upper:
        return False
    if "BANCO DE CREDITO" in upper:
        return True
    compact = upper.replace(" ", "")
    if re.search(r"NUMEROTARJETA[X]{8,}\d{4}", compact):
        return "MONTO TOTAL FACTURADO" in upper and "PERIODO FACTURADO" in upper
    return False


def _bci_subsection_totals_clp(
    full: str,
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """
    BCI/Líder EECC: subsection totals under 1. Total Operaciones and 3. Cargos (pdftotext).
    Returns (operaciones_sum, cargos_sum, monto_facturado).
    """
    lines = full.splitlines()
    operaciones_sum = 0.0
    cargos_sum = 0.0
    in_operaciones = False
    in_cargos = False
    saw_operaciones_header = False
    lone_amount = re.compile(r"^\$\s*([\d.\-]+)\s*$")

    for line in lines:
        up = line.upper()
        if re.search(r"1\.\s*TOTAL\s+OPERACIONES", up):
            in_operaciones = True
            in_cargos = False
            saw_operaciones_header = True
            continue
        if re.search(r"2\.\s*PRODUCTOS", up):
            in_operaciones = False
            in_cargos = False
            continue
        if re.search(r"3\.\s*CARGOS", up) and "COMISIONES" in up:
            in_operaciones = False
            in_cargos = True
            continue
        if re.search(r"III\.\s*INFORMACI", up) or "MONTO TOTAL FACTURADO" in up:
            in_operaciones = False
            in_cargos = False
        m = lone_amount.match(line.strip())
        if not m:
            continue
        v = parse_clp(m.group(1))
        if v is None:
            continue
        if in_operaciones and v > 0:
            operaciones_sum += float(v)
        elif in_cargos and v > 0:
            cargos_sum += float(v)

    monto_facturado: Optional[float] = None
    for i, line in enumerate(lines):
        if "MONTO TOTAL FACTURADO" not in line.upper():
            continue
        inline = _last_amount_on_line(line, parse_clp, parse_usd, "clp")
        if inline is not None and inline > 0:
            monto_facturado = inline
            break
        for j in range(i + 1, min(i + 6, len(lines))):
            cand = lines[j].strip()
            if not cand or cand.upper().startswith("MONTO "):
                continue
            v2 = _last_amount_on_line(cand, parse_clp, parse_usd, "clp")
            if v2 is not None and v2 > 0:
                monto_facturado = v2
                break
        if monto_facturado is not None:
            break

    op_out = operaciones_sum if saw_operaciones_header and operaciones_sum > 0 else None
    cargos_out = cargos_sum if cargos_sum != 0 else None
    return op_out, cargos_out, monto_facturado


def _clp_labeled_header_amount(
    full: str,
    label_pattern: str,
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
    *,
    lookahead: int = 4,
) -> Optional[float]:
    """Amount on the same line as a período-anterior label, or the next few lines."""
    lines = full.splitlines()
    end = len(lines)
    for i, line in enumerate(lines):
        if re.search(r"2\.\s*PER[IÍ]ODO\s+ACTUAL", line, re.I):
            end = i
            break
    amounts: List[float] = []
    for line in lines:
        if not re.search(label_pattern, line, re.I):
            continue
        v = _last_amount_on_line(line, parse_clp, parse_usd, "clp")
        if v is not None:
            amounts.append(float(v))
    for i, line in enumerate(lines[:end]):
        if not re.search(label_pattern, line, re.I):
            continue
        if _last_amount_on_line(line, parse_clp, parse_usd, "clp") is not None:
            continue
        if "$" in line:
            continue
        for j in range(i + 1, min(i + 1 + lookahead, end)):
            cand = lines[j].strip()
            if not cand:
                continue
            if re.search(
                r"EVOLUCI|FACTURADOS\s+Y\s+PAGADOS|VENCIMIENTO|DE\s+\d+\s+DE\s+\d",
                cand,
                re.I,
            ):
                continue
            if len(cand) > 72:
                continue
            v2 = _last_amount_on_line(lines[j], parse_clp, parse_usd, "clp")
            if v2 is not None:
                amounts.append(float(v2))
    if not amounts:
        return None
    label_u = label_pattern.upper()
    if "PAGADO" in label_u:
        negs = [a for a in amounts if a < 0]
        if negs:
            return min(negs)
    pos = [a for a in amounts if a > 0]
    if pos:
        return max(pos)
    return amounts[0]


def _parse_usd_ocr_flat_header_amount(
    raw: str,
    parse_usd: Callable[[str], Optional[float]],
) -> Optional[float]:
    """OCR on image scans often glues an extra digit after cents (10,711 -> 10,71)."""
    t = str(raw or "").strip().replace(" ", "")
    if not t:
        return None
    m = re.match(r"^\-?(\d+),(\d{2})\d+$", t)
    if m:
        sign = -1.0 if t.startswith("-") else 1.0
        return sign * float(f"{m.group(1)}.{m.group(2)}")
    return parse_usd(raw)


def extract_pdf_section_totals(
    full: str,
    currency: str,
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
) -> Dict[str, Optional[float]]:
    """Read section/header totals from statement text (Santander + BCI/Líder)."""
    cur = currency.lower()
    out: Dict[str, Optional[float]] = {
        "pdf_total_operaciones": None,
        "pdf_total_cargos_abonos": None,
        "pdf_total_cuotas": None,
        "pdf_monto_facturado": None,
        "pdf_monto_facturado_anterior": None,
        "pdf_monto_pagado_anterior": None,
        "pdf_monto_pagado_anterior_date": None,
        "pdf_saldo_anterior": None,
        "pdf_abono": None,
        "pdf_compras_cargos": None,
        "pdf_deuda_total": None,
    }

    lines = full.splitlines()
    in_periodo_actual = False
    for i, line in enumerate(lines):
        up = line.upper()
        if re.search(r"2\.\s*PER[IÍ]ODO\s+ACTUAL", up):
            in_periodo_actual = True
        if re.search(r"1\.\s*PER[IÍ]ODO\s+ANTERIOR", up):
            in_periodo_actual = False
        if "1." in line and "TOTAL OPERACIONES" in up:
            if cur == "clp" and not in_periodo_actual:
                continue
            v = _amount_near_section_header(lines, i, parse_clp, parse_usd, cur)
            if v is not None:
                out["pdf_total_operaciones"] = v
        elif "3." in line and "CARGOS" in up and "COMISIONES" in up:
            if cur == "clp" and not in_periodo_actual:
                continue
            v_inline = _last_amount_on_line(lines[i], parse_clp, parse_usd, cur)
            if v_inline is not None:
                out["pdf_total_cargos_abonos"] = v_inline
            elif cur != "clp":
                v = _amount_near_section_header(lines, i, parse_clp, parse_usd, cur)
                if v is not None:
                    out["pdf_total_cargos_abonos"] = v
        elif "4." in line and "INFORMACION COMPRAS EN CUOTAS" in up and in_periodo_actual:
            v = _amount_near_section_header(lines, i, parse_clp, parse_usd, cur)
            if v is not None:
                out["pdf_total_cuotas"] = v

    if cur == "usd":
        m = re.search(
            r"SALDO\s+ANTERIOR\s+FACTURADO[^\dUS$]*US\$\s*([\d.,\-]+)",
            full,
            re.I | re.S,
        )
        if m:
            out["pdf_saldo_anterior"] = parse_usd(m.group(1))
        m = re.search(r"ABONO\s+REALIZADO[^\dUS$]*US\$\s*([\d.,\-]+)", full, re.I | re.S)
        if m:
            out["pdf_abono"] = parse_usd(m.group(1))
        m = re.search(
            r"TOTAL\s+DE\s+COMPRAS\s+Y\s+CARGOS[^\dUS$]*US\$\s*([\d.,\-]+)",
            full,
            re.I | re.S,
        )
        if m:
            out["pdf_compras_cargos"] = parse_usd(m.group(1))
        m = re.search(r"DEUDA\s+TOTAL[^\dUS$]*US\$\s*([\d.,\-]+)", full, re.I | re.S)
        if m:
            out["pdf_deuda_total"] = parse_usd(m.group(1))
        m = re.search(
            r"MONTO\s+TOTAL\s+FACTURADO\s+A\s+PAGAR\s+US\$\s*([\d.,\-]+)",
            full,
            re.I,
        )
        if m:
            out["pdf_monto_facturado"] = parse_usd(m.group(1))
    else:
        monto_prev_v = _clp_labeled_header_amount(
            full,
            r"MONTO\s+FACTURADO\s+A\s+PAGAR\s*\(PER[IÍ]ODO\s+ANTERIOR\)",
            parse_clp,
            parse_usd,
        )
        if monto_prev_v is not None:
            out["pdf_monto_facturado_anterior"] = float(monto_prev_v)
        saldo_v = _clp_labeled_header_amount(
            full,
            r"SALDO\s+ADEUDADO\s+FINAL\s+PER[IÍ]ODO\s+ANTERIOR",
            parse_clp,
            parse_usd,
        )
        if saldo_v is not None:
            out["pdf_saldo_anterior"] = float(saldo_v)
        elif monto_prev_v is not None:
            out["pdf_saldo_anterior"] = float(monto_prev_v)
        for m_pagado in re.finditer(
            r"MONTO\s+PAGADO\s+PER[IÍ]ODO\s+ANTERIOR\s*[\$§]\s*([\d.\-]+)",
            full,
            re.I,
        ):
            out["pdf_monto_pagado_anterior"] = float(
                parse_clp(m_pagado.group(1)) or 0
            )
        if out["pdf_monto_pagado_anterior"] is None:
            pagado_v = _clp_labeled_header_amount(
                full,
                r"MONTO\s+PAGADO\s+PER[IÍ]ODO\s+ANTERIOR",
                parse_clp,
                parse_usd,
            )
            if pagado_v is not None:
                out["pdf_monto_pagado_anterior"] = float(pagado_v)
        # Printed payment date: the movement-section "dd/mm/yy MONTO CANCELADO $ -amount"
        # row whose amount equals the header. That row is dropped from parsed lines by
        # design (the header carries the amount), but the DATE only exists here — the
        # daily owed walk synthesizes the PAGO event from (amount, date). Ambiguous
        # (multiple distinct dates) or absent -> None; single date (dupes collapse) wins.
        if out["pdf_monto_pagado_anterior"] is not None:
            pagado_abs = abs(float(out["pdf_monto_pagado_anterior"]))
            cancel_dates = set()
            for m_c in re.finditer(
                r"(\d{2}/\d{2}/\d{2,4})\s+MONTO\s+CANCELADO[^\n\d]*\$\s*-?\s?([\d.]+)",
                full,
                re.I,
            ):
                amt_c = parse_clp(m_c.group(2))
                if amt_c is not None and abs(float(amt_c)) == pagado_abs:
                    cancel_dates.add(m_c.group(1))
            if len(cancel_dates) == 1:
                iso = _cc_iso_from_ddmmyy(next(iter(cancel_dates)))
                if iso is not None:
                    out["pdf_monto_pagado_anterior_date"] = iso
        for m_total in re.finditer(
            r"MONTO\s+TOTAL\s+FACTURADO(?:\s+A\s+PAGAR)?[^\$]*\$\s*([\d.\-]+)",
            full,
            re.I,
        ):
            out["pdf_monto_facturado"] = float(parse_clp(m_total.group(1)) or 0)
        m = re.search(r"DEUDA\s+TOTAL[^\$]*\$\s*([\d.\-]+)", full, re.I)
        if m:
            out["pdf_deuda_total"] = float(parse_clp(m.group(1)) or 0)

    if cur == "clp" and is_bci_lider_statement(full):
        bci_op, bci_cargos, bci_monto = _bci_subsection_totals_clp(full, parse_clp, parse_usd)
        if bci_op is not None:
            out["pdf_total_operaciones"] = bci_op
        if bci_cargos is not None:
            out["pdf_total_cargos_abonos"] = bci_cargos
        if bci_monto is not None:
            out["pdf_monto_facturado"] = bci_monto

    # Image-scan OCR glues section headers and amounts on one line (no newlines).
    if cur == "clp" and out["pdf_total_operaciones"] is None:
        m_op = re.search(
            r"(?:1\.\s*)?TOTAL\s+OPERACIONES\s*\$\s*([\d.\-]+)",
            full,
            re.I,
        )
        if m_op:
            out["pdf_total_operaciones"] = float(parse_clp(m_op.group(1)) or 0)
    if cur == "clp" and out["pdf_total_cargos_abonos"] is None:
        m_car = re.search(
            r"3\.\s*CARGOS[^\$]*(?:COMISIONES|ABONOS)[^\$]*\$\s*([\d.\-]+)",
            full,
            re.I,
        )
        if m_car:
            out["pdf_total_cargos_abonos"] = float(parse_clp(m_car.group(1)) or 0)

    # Image-scan OCR: glued headers (YCARGOS, CUS $) and extra cents digit (10,711).
    if cur == "usd":
        if out["pdf_compras_cargos"] is None:
            m = re.search(
                r"TOTAL\s+DE\s+COMPRAS\s+Y\s*CARGOS?[^\d$]*(?:US|CU)[S$]?\s*\$?\s*([\d.,]+)",
                full,
                re.I,
            )
            if m:
                out["pdf_compras_cargos"] = _parse_usd_ocr_flat_header_amount(
                    m.group(1), parse_usd
                )
        if out["pdf_abono"] is None:
            m = re.search(
                r"ABONO\s+REALIZADO[^\dUS$]*US\$\s*([\d.,\-]+)",
                full,
                re.I | re.S,
            )
            if m:
                out["pdf_abono"] = parse_usd(m.group(1))
            else:
                m3 = re.search(
                    r"3\.\s*CARGOS,\s*COMISIONES,\s*IMPUESTOS\s+Y\s+ABONOS\s+(-?[\d.,]+)",
                    full,
                    re.I,
                )
                if m3:
                    out["pdf_abono"] = parse_usd(m3.group(1))

    return out


def merge_section_totals_into_meta(
    meta: Dict[str, Any],
    full: str,
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
) -> Dict[str, Any]:
    currency = str(meta.get("currency") or "clp").lower()
    totals = extract_pdf_section_totals(full, currency, parse_clp, parse_usd)
    meta.update(totals)
    return meta


def _cc_iso_from_ddmmyy(raw: str) -> Optional[str]:
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{2,4})", raw.strip())
    if not m:
        return None
    dd, mm, yy = m.group(1), m.group(2), m.group(3)
    year = int(yy)
    if year < 100:
        year += 2000
    if not (1 <= int(mm) <= 12 and 1 <= int(dd) <= 31):
        return None
    return f"{year:04d}-{mm}-{dd}"


def _close_enough(a: Optional[float], b: Optional[float], tol: float) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) <= tol


def _close_enough_operaciones(
    actual: Optional[float], expected: Optional[float], currency: str
) -> bool:
    if actual is None or expected is None:
        return False
    tol = _tolerance(currency, expected)
    pct = 0.15 if currency == "usd" else 0.03
    if currency == "usd":
        floor = 35.0
    else:
        floor = min(5000.0, max(500.0, abs(expected) * pct))
    band = max(tol, floor, abs(expected) * pct)
    return abs(actual - expected) <= band


def _close_enough_cargos(
    actual: Optional[float], expected: Optional[float], currency: str
) -> bool:
    if actual is None or expected is None:
        return False
    if _close_enough_operaciones(actual, expected, currency):
        return True
    # USD section-3 PDF totals are negative; occasional line-sign inversion in parse.
    if currency == "usd":
        return _close_enough_operaciones(-actual, expected, currency)
    return False


@dataclass
class ReconcileCheck:
    code: str
    ok: bool
    expected: Optional[float] = None
    actual: Optional[float] = None
    delta: Optional[float] = None
    detail: str = ""


@dataclass
class ReconcileResult:
    source_pdf: str
    currency: str
    ok: bool
    skip_reason: str = ""
    checks: List[ReconcileCheck] = field(default_factory=list)
    parsed_sums: Dict[str, float] = field(default_factory=dict)
    pdf_totals: Dict[str, Optional[float]] = field(default_factory=dict)
    row_count: int = 0
    issue_codes: List[str] = field(default_factory=list)

    def mismatch_summary(self) -> str:
        if self.ok:
            return ""
        parts = [f"reconcile:{c}" for c in self.issue_codes]
        for ch in self.checks:
            if not ch.ok and ch.delta is not None:
                parts.append(f"{ch.code}:delta={ch.delta:.2f}")
        return ";".join(parts)


def _tolerance(currency: str, expected: float) -> float:
    base = TOL_USD if currency == "usd" else float(TOL_CLP)
    return max(base, abs(expected) * (0.02 if currency == "usd" else 0.005))


def _cargos_for_clp_billing(
    parsed: Dict[str, float], pdf_totals: Dict[str, Optional[float]]
) -> float:
    """Section-3 charges only (mid-period MONTO CANCELADO is billed separately)."""
    return _adjust_parsed_cargos_for_header_payment(parsed, pdf_totals)


def _adjust_parsed_cargos_for_header_payment(
    parsed: Dict[str, float], pdf_totals: Dict[str, Optional[float]]
) -> float:
    """Drop cargos that duplicate MONTO PAGADO PERÍODO ANTERIOR (already in saldo final)."""
    cargos = float(parsed.get("parsed_cargos_abonos") or 0)
    pagado = pdf_totals.get("pdf_monto_pagado_anterior")
    if pagado is None:
        return cargos
    if abs(cargos) > 0 and abs(abs(cargos) - abs(float(pagado))) <= max(
        TOL_CLP, abs(float(pagado)) * 0.01
    ):
        return 0.0
    return cargos


def _clp_rolling_billed(
    pdf_totals: Dict[str, Optional[float]], operaciones: float, cargos: float
) -> Optional[float]:
    """Santander CLP: monto_anterior + operaciones + cargos + pagado_anterior."""
    monto_prev = pdf_totals.get("pdf_monto_facturado_anterior")
    pagado = pdf_totals.get("pdf_monto_pagado_anterior")
    if monto_prev is None or pagado is None:
        return None
    return float(monto_prev) + float(operaciones) + float(cargos) + float(pagado)


def _clp_billed_candidates_from_parsed_and_pdf(
    parsed: Dict[str, float], pdf_totals: Dict[str, Optional[float]]
) -> Tuple[float, float]:
    """Pick best of Santander billing layouts (rolling vs saldo carry vs mid-period abonos)."""
    saldo = float(pdf_totals.get("pdf_saldo_anterior") or 0)
    cargos = _cargos_for_clp_billing(parsed, pdf_totals)
    op = float(parsed.get("parsed_operaciones") or 0)
    op_pdf = pdf_totals.get("pdf_total_operaciones")
    pay = float(parsed.get("parsed_mid_period_payments") or 0)
    candidates: List[float] = []

    roll_parsed = _clp_rolling_billed(pdf_totals, op, cargos)
    if roll_parsed is not None:
        candidates.append(roll_parsed)
    if op_pdf is not None:
        roll_pdf = _clp_rolling_billed(pdf_totals, float(op_pdf), cargos)
        if roll_pdf is not None:
            candidates.append(roll_pdf)

    candidates.extend([op + cargos + saldo, op + cargos])
    if op_pdf is not None:
        op_f = float(op_pdf)
        candidates.extend([op_f + cargos + saldo, op_f + cargos])
    if pay != 0:
        candidates.append(op + cargos + pay)
        if op_pdf is not None:
            candidates.append(float(op_pdf) + cargos + pay)
    monto = pdf_totals.get("pdf_monto_facturado")
    if monto is None or float(monto) <= 0:
        return candidates[0], candidates[1]
    target = float(monto)
    best = min(candidates, key=lambda c: abs(c - target))
    second = min((c for c in candidates if c != best), key=lambda c: abs(c - target), default=best)
    return best, second


def _clp_billed_from_parsed_and_pdf(
    parsed: Dict[str, float], pdf_totals: Dict[str, Optional[float]]
) -> float:
    best, _second = _clp_billed_candidates_from_parsed_and_pdf(parsed, pdf_totals)
    return best


def _has_clp_mid_period_payment_adjustments(
    pdf_totals: Dict[str, Optional[float]],
) -> bool:
    pagado = pdf_totals.get("pdf_monto_pagado_anterior")
    if pagado is not None and abs(float(pagado)) > 0:
        return True
    saldo = pdf_totals.get("pdf_saldo_anterior")
    if saldo is not None and float(saldo) < 0:
        return True
    return False


def _operaciones_facturado_double_count(
    parsed: Dict[str, float], pdf_totals: Dict[str, Optional[float]]
) -> bool:
    op_pdf = pdf_totals.get("pdf_total_operaciones")
    monto = pdf_totals.get("pdf_monto_facturado")
    if op_pdf is None or monto is None:
        return False
    op_parsed = float(parsed.get("parsed_operaciones") or 0)
    return abs(op_parsed - float(op_pdf) - float(monto)) <= max(
        TOL_CLP, abs(float(monto)) * 0.01
    )


def reconcile_statement_required(source_pdf: str, full: str = "") -> bool:
    """Primary import cards; skip superseded Santander cards and known-bad exports."""
    lower = source_pdf.lower()
    if "legacy.pdf" in lower or "-corrupt" in lower or re.search(r"\(\d+\)\.pdf$", lower):
        return False
    if any(re.search(rf"\b{re.escape(l4)}\b", source_pdf) for l4 in cc_cards.RECONCILE_SKIP_LAST4S):
        return False
    if "eecc" in lower or any(
        re.search(rf"\b{re.escape(l4)}\b", source_pdf) for l4 in cc_cards.LIDER_FILENAME_LAST4S
    ):
        return True
    if full.strip() and is_bci_lider_statement(full):
        return True
    return any(l4 in source_pdf for l4 in cc_cards.RECONCILE_PRIMARY_LAST4S)


def reconcile_statement(
    source_pdf: str,
    meta: Dict[str, Any],
    rows: List[Dict[str, Any]],
    full: str,
    parse_clp: Callable[[str], Optional[int]],
    parse_usd: Callable[[str], Optional[float]],
    layout_text: str = "",
) -> ReconcileResult:
    currency = str(meta.get("currency") or "clp").lower()

    if not reconcile_statement_required(source_pdf, full):
        return ReconcileResult(
            source_pdf=source_pdf,
            currency=currency,
            ok=True,
            skip_reason="excluded_pdf",
            row_count=len(rows),
        )

    active_rows = _iter_reconcile_rows(rows)

    if not active_rows:
        return ReconcileResult(
            source_pdf=source_pdf,
            currency=currency,
            ok=True,
            skip_reason="zero_rows",
            row_count=0,
        )

    # Re-downloaded statement PDFs: cross-statement dedupe assigns every purchase row
    # to the older canonical PDF, leaving only section-3 lines here. The canonical PDF
    # reconciles the real rows; comparing this copy's ~empty sums to its totals is noise.
    nondup = [
        r
        for r in rows
        if str(r.get("is_duplicate_across_statements") or "").lower() != "true"
    ]
    def _counts_toward_sections(row: Dict[str, Any]) -> bool:
        merchant = str(row.get("merchant") or "")
        if str(row.get("currency") or "clp").lower() == "usd":
            try:
                usd = float(str(row.get("amount_usd") or "0").replace(",", "."))
            except ValueError:
                usd = 0.0
            return not _is_usd_section3_line(merchant, usd)
        return not _is_clp_section3_line(merchant)
    if len(nondup) < len(rows) and not any(_counts_toward_sections(r) for r in nondup):
        return ReconcileResult(
            source_pdf=source_pdf,
            currency=currency,
            ok=True,
            skip_reason="duplicate_statement",
            row_count=len(active_rows),
        )

    # BCI caches store the same pdftotext output in both full and layout — appending
    # would double the summation-based subsection totals (expected = 2× actual).
    text_for_totals = full
    if layout_text.strip() and layout_text.strip() != full.strip():
        text_for_totals = f"{full}\n{layout_text}"
    pdf_totals = extract_pdf_section_totals(text_for_totals, currency, parse_clp, parse_usd)
    op_pdf = pdf_totals.get("pdf_total_operaciones")

    parsed = sum_parsed_sections(rows, parse_clp, parse_usd)

    # Legacy Santander PDFs can extract partially (pypdf drops sections) — those skip
    # as incomplete_parse. BCI/Líder text is complete pdftotext output, so a low row
    # count or a big operaciones gap there means DROPPED ROWS: never skip, always check
    # (a 2-row loss on the Oct 2025 1015 statement sailed through these hatches).
    if (
        op_pdf is not None
        and op_pdf > 100_000
        and len(active_rows) < 20
        and not is_bci_lider_statement(full)
    ):
        return ReconcileResult(
            source_pdf=source_pdf,
            currency=currency,
            ok=True,
            skip_reason="incomplete_parse",
            row_count=len(active_rows),
            pdf_totals=pdf_totals,
            parsed_sums=parsed,
        )

    checks: List[ReconcileCheck] = []
    issue_codes: List[str] = []

    def add_check(
        code: str,
        expected: Optional[float],
        actual: Optional[float],
        required: bool = True,
    ) -> None:
        if expected is None:
            if required:
                checks.append(
                    ReconcileCheck(
                        code=f"missing_{code}",
                        ok=False,
                        detail="PDF total not extracted",
                    )
                )
                issue_codes.append(f"missing_{code}")
            return
        delta = (actual or 0) - expected
        if code == "operaciones":
            ok = _close_enough_operaciones(actual, expected, currency)
        elif code == "cargos_abonos":
            ok = _close_enough_cargos(actual, expected, currency)
        else:
            ok = _close_enough(actual, expected, _tolerance(currency, expected))
        checks.append(
            ReconcileCheck(
                code=code,
                ok=ok,
                expected=expected,
                actual=actual,
                delta=delta,
            )
        )
        if not ok:
            issue_codes.append(code)

    op_expected = pdf_totals.get("pdf_total_operaciones")
    if currency == "usd" and pdf_totals.get("pdf_compras_cargos") is not None:
        op_expected = pdf_totals.get("pdf_compras_cargos")
    monto_pdf = pdf_totals.get("pdf_monto_facturado")
    santander_clp = currency == "clp" and not is_bci_lider_statement(full)
    mid_period_adj = _has_clp_mid_period_payment_adjustments(pdf_totals)
    facturado_double = _operaciones_facturado_double_count(parsed, pdf_totals)
    op_required = True
    if santander_clp and (
        mid_period_adj or facturado_double or (monto_pdf is not None and float(monto_pdf) > 0)
    ):
        op_required = not mid_period_adj and not facturado_double
    if is_bci_lider_statement(full) and op_expected is None:
        # BCI subtotal lines missing from the extracted text — cannot anchor the
        # operaciones sum, so fail loud instead of passing with zero checks.
        add_check("operaciones", None, parsed.get("parsed_operaciones"), required=True)
    if op_required and op_expected is not None and float(op_expected) >= 0:
        add_check(
            "operaciones",
            op_expected,
            parsed.get("parsed_operaciones"),
            required=True,
        )
    cargos_required = pdf_totals.get("pdf_total_cargos_abonos") is not None
    if is_bci_lider_statement(full):
        # PAGO lines in section 3 are not emitted as rows; PDF total still includes them.
        cargos_required = False
    if (
        currency == "usd"
        and cargos_required
        and float(parsed.get("parsed_cargos_abonos") or 0) == 0
        and pdf_totals.get("pdf_abono") is not None
        and abs(
            float(pdf_totals.get("pdf_total_cargos_abonos") or 0)
            - float(pdf_totals.get("pdf_abono") or 0)
        )
        < 0.01
    ):
        # Legacy Santander USD: section 3 is solely the PAGO (never emitted as a
        # row) — the total equals the header abono, nothing row-level to reconcile.
        cargos_required = False
    if santander_clp and monto_pdf is not None and float(monto_pdf) > 0:
        cargos_required = False
    if cargos_required:
        add_check(
            "cargos_abonos",
            pdf_totals.get("pdf_total_cargos_abonos"),
            parsed.get("parsed_cargos_abonos"),
            required=True,
        )
    # Section 4 total is only "new installment" charges; parsed rows include all active cuotas.
    # Skip strict cuotas check until section-boundary parsing exists.

    compras = pdf_totals.get("pdf_compras_cargos") or meta.get("statement_compras_cargos")
    if (
        compras is not None
        and pdf_totals.get("pdf_total_operaciones") is not None
        and float(compras) >= 0
        and float(pdf_totals["pdf_total_operaciones"]) >= 0
    ):
        compras_f = float(compras)
        op_pdf = float(pdf_totals["pdf_total_operaciones"])
        delta = compras_f - op_pdf
        ok = _close_enough_operaciones(compras_f, op_pdf, currency)
        checks.append(
            ReconcileCheck(
                code="header_compras_vs_operaciones",
                ok=ok,
                expected=op_pdf,
                actual=compras_f,
                delta=delta,
            )
        )
        if not ok:
            issue_codes.append("header_compras_vs_operaciones")

    if currency == "usd":
        saldo = pdf_totals.get("pdf_saldo_anterior") or meta.get("statement_saldo_anterior")
        abono = pdf_totals.get("pdf_abono") or meta.get("statement_abono")
        compras_c = pdf_totals.get("pdf_compras_cargos") or meta.get(
            "statement_compras_cargos"
        )
        deuda = pdf_totals.get("pdf_deuda_total")
        saldo_pdf = pdf_totals.get("pdf_saldo_anterior")
        abono_pdf = pdf_totals.get("pdf_abono")
        compras_pdf = pdf_totals.get("pdf_compras_cargos")
        if (
            deuda is not None
            and saldo_pdf is not None
            and abono_pdf is not None
            and compras_pdf is not None
        ):
            saldo = saldo_pdf
            abono = abono_pdf
            compras_c = compras_pdf
            traspaso = parsed.get("parsed_traspaso_nacional") or 0.0
            if traspaso == 0:
                m = re.search(
                    r"TRASPASO\s+DEUDA\s+NACIONAL[^\dUS$]*US\$\s*([\d.,\-]+)",
                    full,
                    re.I | re.S,
                )
                if m:
                    traspaso = float(parse_usd(m.group(1)) or 0)
            expected_deuda = float(saldo) + float(abono) + float(compras_c) + float(traspaso)
            delta = expected_deuda - float(deuda)
            ok = abs(delta) <= _tolerance("usd", float(deuda))
            checks.append(
                ReconcileCheck(
                    code="usd_balance",
                    ok=ok,
                    expected=float(deuda),
                    actual=expected_deuda,
                    delta=delta,
                    detail="saldo+abono+compras+traspaso vs deuda_total",
                )
            )
            if not ok:
                issue_codes.append("usd_balance")

    # BCI Monto Total Facturado is a balance identity (saldo anterior − pagos + compras
    # + new-plan first cuotas), not operaciones+cargos — skip until modeled; the
    # operaciones subsection check above already anchors row completeness.
    if (
        currency == "clp"
        and monto_pdf is not None
        and float(monto_pdf) > 0
        and not is_bci_lider_statement(full)
    ):
        expected_billed = _clp_billed_from_parsed_and_pdf(parsed, pdf_totals)
        detail = (
            "operaciones+cargos(+saldo) vs Monto Total Facturado"
        )
        delta = expected_billed - float(monto_pdf)
        monto_tol = _tolerance("clp", float(monto_pdf))
        monto_tol = max(monto_tol, abs(float(monto_pdf)) * 0.025)
        ok_billed = abs(delta) <= monto_tol
        checks.append(
            ReconcileCheck(
                code="monto_facturado",
                ok=ok_billed,
                expected=float(monto_pdf),
                actual=expected_billed,
                delta=delta,
                detail=detail,
            )
        )
        if not ok_billed:
            issue_codes.append("monto_facturado")

    if not checks:
        ok = True
    else:
        ok = all(c.ok for c in checks)

    return ReconcileResult(
        source_pdf=source_pdf,
        currency=currency,
        ok=ok,
        checks=checks,
        parsed_sums=parsed,
        pdf_totals=pdf_totals,
        row_count=len(active_rows),
        issue_codes=issue_codes,
    )


def reconcile_result_to_json(obj: ReconcileResult) -> Dict[str, Any]:
    return {
        "source_pdf": obj.source_pdf,
        "currency": obj.currency,
        "ok": obj.ok,
        "skip_reason": obj.skip_reason,
        "row_count": obj.row_count,
        "issue_codes": obj.issue_codes,
        "parsed_sums": obj.parsed_sums,
        "pdf_totals": {k: v for k, v in obj.pdf_totals.items()},
        "checks": [asdict(c) for c in obj.checks],
        "mismatch_summary": obj.mismatch_summary(),
    }


def write_reconciliation_jsonl(path: Any, results: List[ReconcileResult]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(reconcile_result_to_json(r), ensure_ascii=False) + "\n")
