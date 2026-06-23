#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parse Chilean payroll liquidación PDFs under cfraser/liquidaciones/ into JSON cache.

System tools: poppler (`pdftotext`), tesseract + pymupdf for image scans (see `cc_pdf_ocr.py`).

From repo root:
  npm run parse:payroll-liquidaciones
  npm run import:payroll-liquidaciones -w nw-tracker-server

Cache: cfraser/payroll-parsing-output/per-pdf/<sha256>.json
Flags: --no-cache, --force-reparse, --skip=rel/path.pdf (repeatable)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
CFRASER_DIR = REPO_ROOT / "cfraser"
LIQUIDACIONES_DIR = Path(
    os.environ.get("CFRASER_LIQUIDACIONES_DIR", str(CFRASER_DIR / "liquidaciones"))
)
PARSE_CACHE_DIR = Path(
    os.environ.get(
        "PAYROLL_PARSE_CACHE_DIR",
        str(CFRASER_DIR / "payroll-parsing-output"),
    )
)
PARSE_CACHE_PER_PDF_DIR = PARSE_CACHE_DIR / "per-pdf"
PARSER_VERSION_FILES = (
    SCRIPT_DIR / "parse-payroll-liquidaciones.py",
    SCRIPT_DIR / "cc_pdf_ocr.py",
)


def parser_version_hash() -> str:
    h = hashlib.sha256()
    for p in PARSER_VERSION_FILES:
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def pdf_bytes_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pdftotext_layout(path: Path) -> str:
    try:
        out = subprocess.check_output(
            ["pdftotext", "-layout", str(path), "-"],
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as e:
        raise RuntimeError("pdftotext not found (install poppler)") from e
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"pdftotext failed for {path}: {e.stderr.decode()}") from e
    return out.decode("utf-8", errors="replace")


def extract_payroll_pdf_text(path: Path) -> str:
    """pdftotext first; OCR when the PDF is an image scan (no text layer)."""
    text = pdftotext_layout(path)
    if len(text.strip()) >= 40:
        return text
    sys.path.insert(0, str(SCRIPT_DIR))
    from cc_pdf_ocr import extract_cc_pdf_ocr_flat

    ocr = extract_cc_pdf_ocr_flat(path).strip()
    if len(ocr) < 40:
        raise ValueError("empty or unreadable PDF (OCR yielded no text)")
    return ocr


def normalize_ocr_payroll_text(text: str) -> str:
    """Collapse OCR spacing glitches inside CLP amounts (e.g. ``367 ,364``)."""
    return re.sub(
        r"(\d{1,3}(?:[.\s]\d{3})*)\s*,\s*(\d{2,3})\b",
        lambda m: m.group(1).replace(" ", "").replace(".", "") + "," + m.group(2),
        text,
    )


def amount_after_ocr_label(text: str, labels: Tuple[str, ...]) -> Optional[int]:
    for label in labels:
        pat = rf"{re.escape(label)}(.{{0,48}})"
        m = re.search(pat, text, re.IGNORECASE)
        if not m:
            continue
        tail = m.group(1)
        amt_m = re.search(r"([\d]{1,3}(?:[.,\s]\d{3})+)", tail)
        if not amt_m:
            continue
        compact = re.sub(r"\s+", "", amt_m.group(1))
        v = parse_clp_amount(compact)
        if v is not None:
            return v
    return None


def parse_clp_amount(raw: str) -> Optional[int]:
    s = str(raw or "").strip()
    if not s or s in ("-", "0", "0,0", "0,00", "0,0000", "00"):
        return None
    # 3.500.000,00
    m = re.fullmatch(r"(\d{1,3}(?:\.\d{3})*),(\d{2})", s)
    if m:
        return int(m.group(1).replace(".", ""))
    # 1,009,422 or 2,000,001
    if "," in s and "." not in s:
        return int(s.replace(",", ""))
    # 3.062.633 or 2.063.000
    if "." in s:
        parts = s.split(".")
        if len(parts) > 1 and all(len(p) == 3 for p in parts[1:]):
            return int("".join(parts))
    digits = re.sub(r"[^\d]", "", s)
    if not digits:
        return None
    return int(digits)


def parse_uf_amount(raw: str) -> Optional[float]:
    s = str(raw or "").strip().replace(" ", "")
    if not s:
        return None
    if "," in s and "." not in s:
        return float(s.replace(".", "").replace(",", "."))
    if "." in s and "," in s:
        return float(s.replace(".", "").replace(",", "."))
    return float(s.replace(",", "."))


def amount_after_label(text: str, labels: Tuple[str, ...]) -> Optional[int]:
    for label in labels:
        pat = rf"{re.escape(label)}(?:\s*\(LQ\))?\s+([\d.,]+)"
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            v = parse_clp_amount(m.group(1))
            if v is not None:
                return v
    return None


def extract_liquido_a_pagar(text: str) -> int:
    """Líquido is often on the line after the LIQUIDO A PAGAR header row."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not re.search(r"L[IÍ]QUIDO A PAGAR", line, re.IGNORECASE):
            continue
        same_line = re.findall(r"([\d]{1,3}(?:\.[\d]{3})+)", line)
        if same_line:
            v = parse_clp_amount(same_line[-1])
            if v is not None and v > 0:
                return v
        for j in range(i + 1, min(i + 4, len(lines))):
            amounts = re.findall(r"([\d]{1,3}(?:\.[\d]{3})+)", lines[j])
            parsed = [parse_clp_amount(a) for a in amounts]
            parsed = [p for p in parsed if p is not None and p > 0]
            if parsed:
                return parsed[-1]
    m = re.search(
        r"L[IÍ]QUIDO A PAGAR\s+([\d,]+)",
        text,
        re.IGNORECASE,
    )
    if m:
        v = parse_clp_amount(m.group(1))
        if v is not None and v > 0:
            return v
    raise ValueError("missing LIQUIDO A PAGAR")


def period_month_from_path(path: Path) -> str:
    m = re.search(r"(\d{4})-(\d{2})\.pdf$", path.name, re.IGNORECASE)
    if not m:
        raise ValueError(f"cannot infer period_month from filename: {path.name}")
    return f"{m.group(1)}-{m.group(2)}"


def rel_source_pdf(path: Path) -> str:
    try:
        return path.relative_to(CFRASER_DIR).as_posix()
    except ValueError:
        return path.as_posix()


def detect_format(text: str) -> str:
    upper = text.upper()
    normalized = (
        upper.replace("Ó", "O")
        .replace("Í", "I")
        .replace("Á", "A")
        .replace("É", "E")
        .replace("Ú", "U")
        .replace("Ñ", "N")
    )
    if "LIQUIDACION DE REMUNERACIONES" in normalized and (
        "SUELDO GANADO" in normalized or "DETALLE DE HABERES" in normalized
    ):
        return "talana_buk"
    if "RAZON SOCIAL" in normalized and "LIQUIDACION DE SUELDO" in normalized:
        if re.search(r"TOTAL\s*A\s*PAGAR|TOTALAPAGAR", normalized, re.IGNORECASE):
            return "unholster_scan"
        return "axity"
    if "LIQUIDACION DE SUELDO" in normalized:
        if re.search(r"Empresa\s*:", text, re.IGNORECASE):
            return "dealsy"
        return "dealsy"
    if "LIQUIDACION DE REMUNERACIONES" in normalized:
        if "ALCANCE L" in normalized or "NUEVO CHILE" in normalized:
            return "nuevo_chile"
    if "ALCANCE L" in normalized and "TOTAL HABERES" in normalized:
        return "nuevo_chile"
    raise ValueError("unknown payroll PDF layout")


def parse_talana_buk(text: str, period_month: str) -> Dict[str, Any]:
    employer_m = re.search(
        r"^([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÚÑ0-9 .&-]+(?:SPA|S\.A\.|LTDA))\s*$",
        text,
        re.MULTILINE | re.IGNORECASE,
    )
    employer_name = employer_m.group(1).strip() if employer_m else "UNKNOWN"
    rut_m = re.search(r"RUT:\s*([\d.\s-]+)", text, re.IGNORECASE)
    employer_rut = rut_m.group(1).strip() if rut_m else None

    period_m = re.search(
        r"REMUNERACION DEL MES\s*\n\s*([A-ZÁÉÍÓÚÑ]+/\d{4})",
        text,
        re.IGNORECASE,
    )
    pay_period_label = period_m.group(1).strip() if period_m else period_month

    liquido_clp = extract_liquido_a_pagar(text)

    base_salary = amount_after_label(
        text, ("Sueldo Ganado", "Sueldo del Mes", "SUELDO BASE S/CONTRATO")
    )
    gratificacion = amount_after_label(text, ("Gratificacion", "Gratificación"))
    colacion = amount_after_label(
        text, ("Asig. Colación", "Asignacion de Colacion", "Asignación de Colación")
    )
    movilizacion = amount_after_label(
        text, ("Asig. Movilización", "Asignacion de Movilizacion", "Asignación de Movilización")
    )

    total_imponible = amount_after_label(text, ("TOTAL IMPONIBLE",))
    total_no_imponible = amount_after_label(text, ("TOTAL NO IMPONIBLE",))
    total_haberes = amount_after_label(text, ("TOTAL HABERES",))
    total_descuentos = amount_after_label(text, ("TOTAL DESCUENTOS",))

    desc_afp = amount_after_label(text, ("Descuento AFP", "COTIZACION OBLIGATORIA AFP"))
    desc_health = amount_after_label(text, ("Cotizacion Salud", "Cotización Salud", "7 % ISAPRE"))
    desc_tax = amount_after_label(
        text, ("Impuesto Unico", "Impuesto Único", "IMPUESTO UNICO TRABAJADORES")
    )
    desc_cesantia = amount_after_label(
        text, ("Seguro de Desempleo", "SEG CESANTIA TRABAJADOR", "Seguro De Cesantía")
    )
    desc_apv = amount_after_label(text, ("DESCUENTO APV",))

    uf_m = re.search(r"VALOR UF\s+([\d.,]+)", text, re.IGNORECASE)
    uf_mes = parse_uf_amount(uf_m.group(1)) if uf_m else None

    tope_prev_m = re.search(r"Tope Imponible\s+([\d.,]+)\s*UF", text, re.IGNORECASE)
    tope_ces_m = re.search(r"Tope de Cesant[ií]a\s+([\d.,]+)\s*UF", text, re.IGNORECASE)

    return {
        "format": "talana_buk",
        "period_month": period_month,
        "employer_name": employer_name,
        "employer_rut": employer_rut,
        "pay_period_label": pay_period_label,
        "earning_type": "salary",
        "base_salary_clp": base_salary,
        "colacion_clp": colacion,
        "movilizacion_clp": movilizacion,
        "gratificacion_clp": gratificacion,
        "total_imponible_clp": total_imponible,
        "total_no_imponible_clp": total_no_imponible,
        "total_haberes_clp": total_haberes,
        "desc_afp_clp": desc_afp,
        "desc_health_clp": desc_health,
        "desc_tax_clp": desc_tax,
        "desc_cesantia_clp": desc_cesantia,
        "desc_apv_clp": desc_apv,
        "desc_other_clp": None,
        "total_descuentos_clp": total_descuentos,
        "liquido_clp": liquido_clp,
        "uf_mes": uf_mes,
        "utm_mes": None,
        "tope_previsional_uf": parse_uf_amount(tope_prev_m.group(1)) if tope_prev_m else None,
        "tope_cesantia_uf": parse_uf_amount(tope_ces_m.group(1)) if tope_ces_m else None,
    }


def parse_dealsy(text: str, period_month: str) -> Dict[str, Any]:
    emp_m = re.search(r"Empresa\s*:\s*([^\n]+)", text, re.IGNORECASE)
    employer_name = emp_m.group(1).strip() if emp_m else "UNKNOWN"
    rut_m = re.search(r"RUT\s*:\s*([\d.\s-]+)", text, re.IGNORECASE)
    employer_rut = rut_m.group(1).strip() if rut_m else None

    period_m = re.search(
        r"LIQUIDACI[OÓ]N DE SUELDO\s*\(([^)]+)\)",
        text,
        re.IGNORECASE,
    )
    pay_period_label = period_m.group(1).strip() if period_m else period_month

    liquido = amount_after_label(text, ("Sueldo Líquido", "Sueldo Liquido"))
    if liquido is None or liquido <= 0:
        m = re.search(r"\$\s*([\d.]+)", text)
        if m:
            liquido = parse_clp_amount(m.group(1))
    if liquido is None or liquido <= 0:
        raise ValueError("missing Sueldo Líquido")

    base_salary = amount_after_label(text, ("Sueldo Base",))
    gratificacion = amount_after_label(text, ("Gratificación", "Gratificacion"))
    colacion = amount_after_label(text, ("Colación", "Colacion"))
    movilizacion = amount_after_label(text, ("Movilización", "Movilizacion"))
    total_imponible = amount_after_label(
        text, ("Sub Total Haberes Imponibles", "Sub total haberes imponibles")
    )
    total_haberes = amount_after_label(text, ("Total Haberes",))
    total_descuentos = amount_after_label(text, ("Total Descuentos",))

    desc_afp = amount_after_label(text, ("Fondo De Pensiones", "Fondo de Pensiones"))
    desc_health = amount_after_label(text, ("Fondo De Salud", "Fondo de Salud"))
    desc_cesantia = amount_after_label(text, ("Seguro De Cesantía", "Seguro de Cesantía"))
    desc_tax = amount_after_label(text, ("Impuesto Único", "Impuesto Unico"))

    uf_m = re.search(r"UF del mes\s*:\s*([\d.,]+)", text, re.IGNORECASE)
    utm_m = re.search(r"UTM de mes\s*:\s*([\d.,]+)", text, re.IGNORECASE)

    no_imponible = None
    if total_haberes is not None and total_imponible is not None:
        extra = (colacion or 0) + (movilizacion or 0)
        if extra > 0:
            no_imponible = extra

    return {
        "format": "dealsy",
        "period_month": period_month,
        "employer_name": employer_name,
        "employer_rut": employer_rut,
        "pay_period_label": pay_period_label,
        "earning_type": "salary",
        "base_salary_clp": base_salary,
        "colacion_clp": colacion,
        "movilizacion_clp": movilizacion,
        "gratificacion_clp": gratificacion,
        "total_imponible_clp": total_imponible,
        "total_no_imponible_clp": no_imponible,
        "total_haberes_clp": total_haberes,
        "desc_afp_clp": desc_afp,
        "desc_health_clp": desc_health,
        "desc_tax_clp": desc_tax,
        "desc_cesantia_clp": desc_cesantia,
        "desc_apv_clp": None,
        "desc_other_clp": None,
        "total_descuentos_clp": total_descuentos,
        "liquido_clp": liquido,
        "uf_mes": parse_uf_amount(uf_m.group(1)) if uf_m else None,
        "utm_mes": parse_uf_amount(utm_m.group(1)) if utm_m else None,
        "tope_previsional_uf": None,
        "tope_cesantia_uf": None,
    }


def parse_nuevo_chile(text: str, period_month: str) -> Dict[str, Any]:
    emp_m = re.search(
        r"EMPRESA\s+([A-ZÁÉÍÓÚÑ0-9][^\n]+(?:SPA|S\.A\.|LTDA))",
        text,
        re.IGNORECASE,
    )
    employer_name = emp_m.group(1).strip() if emp_m else "UNKNOWN"
    rut_m = re.search(r"RUT\s+([\d.\s-]+)", text, re.IGNORECASE)
    employer_rut = rut_m.group(1).strip() if rut_m else None

    month_m = re.search(
        r"(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(\d{4})",
        text,
        re.IGNORECASE,
    )
    pay_period_label = (
        f"{month_m.group(1).title()} {month_m.group(2)}" if month_m else period_month
    )

    liquido = amount_after_label(
        text, ("Alcance Líquido", "Alcance Liquido", "Líquido a Pago", "Liquido a Pago")
    )
    if liquido is None or liquido <= 0:
        raise ValueError("missing Alcance Líquido / Líquido a Pago")

    base_salary = amount_after_label(text, ("Sueldo del Mes",))
    gratificacion = amount_after_label(
        text, ("Gratificación Mensual", "Gratificacion Mensual")
    )
    colacion = amount_after_label(text, ("Colación", "Colacion"))
    movilizacion = amount_after_label(text, ("Movilización", "Movilizacion"))
    total_imponible = amount_after_label(text, ("Total Haberes Imponibles",))
    total_no_imponible = amount_after_label(text, ("Total Haberes No Imponibles",))
    total_haberes = amount_after_label(text, ("Total Haberes",))
    total_descuentos = amount_after_label(text, ("Total Descuentos",))

    desc_afp = amount_after_label(text, ("AFP",))
    desc_health = amount_after_label(text, ("FONASA INP", "Isapre"))
    desc_cesantia = amount_after_label(text, ("Seguro de cesantía", "Seguro de Cesantía"))
    desc_tax = amount_after_label(text, ("Impuesto Unico", "Impuesto Único"))

    uf_m = re.search(r"VALOR UF\s+([\d.,]+)", text, re.IGNORECASE)

    return {
        "format": "nuevo_chile",
        "period_month": period_month,
        "employer_name": employer_name,
        "employer_rut": employer_rut,
        "pay_period_label": pay_period_label,
        "earning_type": "salary",
        "base_salary_clp": base_salary,
        "colacion_clp": colacion,
        "movilizacion_clp": movilizacion,
        "gratificacion_clp": gratificacion,
        "total_imponible_clp": total_imponible,
        "total_no_imponible_clp": total_no_imponible,
        "total_haberes_clp": total_haberes,
        "desc_afp_clp": desc_afp,
        "desc_health_clp": desc_health,
        "desc_tax_clp": desc_tax,
        "desc_cesantia_clp": desc_cesantia,
        "desc_apv_clp": None,
        "desc_other_clp": None,
        "total_descuentos_clp": total_descuentos,
        "liquido_clp": liquido,
        "uf_mes": parse_uf_amount(uf_m.group(1)) if uf_m else None,
        "utm_mes": None,
        "tope_previsional_uf": None,
        "tope_cesantia_uf": None,
    }


def parse_axity(text: str, period_month: str) -> Dict[str, Any]:
    emp_m = re.search(r"RAZON SOCIAL\s+([^\n]+)", text, re.IGNORECASE)
    employer_name = emp_m.group(1).strip() if emp_m else "UNKNOWN"
    rut_m = re.search(r"RUT\s+'?([\d.\s-]+)", text, re.IGNORECASE)
    employer_rut = rut_m.group(1).strip() if rut_m else None

    period_m = re.search(r"MES\s*:\s*([^\n]+)", text, re.IGNORECASE)
    pay_period_label = period_m.group(1).strip() if period_m else period_month

    liquido_m = re.search(
        r"LIQUIDO A PAGAR\s+([\d,]+)",
        text,
        re.IGNORECASE,
    )
    if not liquido_m:
        raise ValueError("missing LIQUIDO A PAGAR")
    liquido_clp = parse_clp_amount(liquido_m.group(1))
    if liquido_clp is None or liquido_clp <= 0:
        raise ValueError(f"invalid liquido_clp: {liquido_m.group(1)!r}")

    base_salary = amount_after_label(text, ("SUELDO BASE", "Sueldo Base"))
    gratificacion = amount_after_label(
        text, ("GRATIFICACION LEGAL", "Gratificacion Legal", "Gratificación Legal")
    )
    colacion = amount_after_label(
        text, ("ASIGNACION DE COLACION", "Asignacion de Colacion")
    )
    movilizacion = amount_after_label(
        text, ("ASIGNACION DE MOVILIZACION", "Asignacion de Movilizacion")
    )
    total_imponible = amount_after_label(text, ("TOTAL IMPONIBLE",))
    total_haberes = None
    total_desc_m = re.search(r"TOTAL DESCUENTOS LEGALES\s+([\d,]+)", text, re.IGNORECASE)
    total_descuentos = (
        parse_clp_amount(total_desc_m.group(1)) if total_desc_m else None
    )

    desc_afp = amount_after_label(text, ("COTIZACION OBLIGATORIA AFP",))
    desc_health = amount_after_label(text, ("7 % ISAPRE", "7% ISAPRE"))
    desc_cesantia = amount_after_label(text, ("SEG CESANTIA TRABAJADOR",))
    desc_tax = amount_after_label(text, ("IMPUESTO UNICO TRABAJADORES",))

    no_imponible = None
    if colacion is not None or movilizacion is not None:
        no_imponible = (colacion or 0) + (movilizacion or 0)
    if total_imponible is not None and no_imponible is not None:
        total_haberes = total_imponible + no_imponible

    return {
        "format": "axity",
        "period_month": period_month,
        "employer_name": employer_name,
        "employer_rut": employer_rut,
        "pay_period_label": pay_period_label,
        "earning_type": "salary",
        "base_salary_clp": base_salary,
        "colacion_clp": colacion,
        "movilizacion_clp": movilizacion,
        "gratificacion_clp": gratificacion,
        "total_imponible_clp": total_imponible,
        "total_no_imponible_clp": no_imponible,
        "total_haberes_clp": total_haberes,
        "desc_afp_clp": desc_afp,
        "desc_health_clp": desc_health,
        "desc_tax_clp": desc_tax,
        "desc_cesantia_clp": desc_cesantia,
        "desc_apv_clp": None,
        "desc_other_clp": None,
        "total_descuentos_clp": total_descuentos,
        "liquido_clp": liquido_clp,
        "uf_mes": None,
        "utm_mes": None,
        "tope_previsional_uf": None,
        "tope_cesantia_uf": None,
    }


def parse_unholster_scan(text: str, period_month: str) -> Dict[str, Any]:
    """UNHOLSTER S.A. flat OCR liquidaciones (Apr–Sep 2018 scans)."""
    flat = normalize_ocr_payroll_text(text)
    emp_m = re.search(r"Razon Social:\s*([^\n]+)", flat, re.IGNORECASE)
    employer_name = emp_m.group(1).strip() if emp_m else "UNKNOWN"
    employer_name = re.sub(
        r"\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b.*$",
        "",
        employer_name,
        flags=re.IGNORECASE,
    ).strip()
    rut_m = re.search(r"R\.?U\.?T\.?\s*:?\s*'?([\d.\s-]+)", flat, re.IGNORECASE)
    employer_rut = rut_m.group(1).strip() if rut_m else None

    month_m = re.search(
        r"(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})",
        flat,
        re.IGNORECASE,
    )
    pay_period_label = (
        f"{month_m.group(1).title()} de {month_m.group(2)}" if month_m else period_month
    )

    liquido_clp = amount_after_ocr_label(
        flat, ("TOTAL APAGAR", "TOTAL A PAGAR", "TOTALAPAGAR")
    )
    if liquido_clp is None or liquido_clp <= 0:
        raise ValueError("missing TOTAL A PAGAR")

    base_salary = amount_after_ocr_label(flat, ("Sueldo Base",))
    gratificacion = amount_after_ocr_label(
        flat,
        (
            "GRATIFICACION 25% DE REMUNERACIONES",
            "GRATIFICACION 25% CON TOPE LEGAL",
            "Gratificacion 25%",
        ),
    )
    colacion = amount_after_ocr_label(flat, ("COLACION", "Colación", "Colacion"))
    movilizacion = amount_after_ocr_label(
        flat, ("MOVILIZACION", "Movilización", "Movilizacion")
    )
    total_imponible = amount_after_ocr_label(
        flat, ("TOTALIMPONIBLES", "TOTAL IMPONIBLES")
    )
    total_no_imponible = amount_after_ocr_label(
        flat, ("TOTAL NO IMPONIBLES",)
    )
    total_haberes = amount_after_ocr_label(flat, ("TOTAL HABERES",))
    total_descuentos = amount_after_ocr_label(flat, ("TOTAL DESCUENTOS",))

    desc_cesantia = amount_after_ocr_label(
        flat, ("SEGURO CESANTIA", "Seguro de Cesantía", "Seguro De Cesantía")
    )
    desc_afp = amount_after_ocr_label(
        flat,
        (
            "A.F.P. PLANVITAL",
            "A.F.P.",
            "Fondo De Pensiones",
            "COTIZACION OBLIGATORIA AFP",
        ),
    )
    desc_health = amount_after_ocr_label(
        flat, ("Isapre CRUZ BLANCA", "Isapre", "Fondo De Salud", "7 % ISAPRE")
    )
    desc_tax = amount_after_ocr_label(
        flat, ("IMPUESTO UNICO", "Impuesto Único", "Impuesto Unico")
    )

    uf_m = re.search(r"Valor UF:\s*([\d.,]+)", flat, re.IGNORECASE)

    return {
        "format": "unholster_scan",
        "period_month": period_month,
        "employer_name": employer_name,
        "employer_rut": employer_rut,
        "pay_period_label": pay_period_label,
        "earning_type": "salary",
        "base_salary_clp": base_salary,
        "colacion_clp": colacion,
        "movilizacion_clp": movilizacion,
        "gratificacion_clp": gratificacion,
        "total_imponible_clp": total_imponible,
        "total_no_imponible_clp": total_no_imponible,
        "total_haberes_clp": total_haberes,
        "desc_afp_clp": desc_afp,
        "desc_health_clp": desc_health,
        "desc_tax_clp": desc_tax,
        "desc_cesantia_clp": desc_cesantia,
        "desc_apv_clp": None,
        "desc_other_clp": None,
        "total_descuentos_clp": total_descuentos,
        "liquido_clp": liquido_clp,
        "uf_mes": parse_uf_amount(uf_m.group(1)) if uf_m else None,
        "utm_mes": None,
        "tope_previsional_uf": None,
        "tope_cesantia_uf": None,
    }


def parse_payroll_pdf(path: Path) -> Dict[str, Any]:
    text = extract_payroll_pdf_text(path)
    period_month = period_month_from_path(path)
    fmt = detect_format(text)
    if fmt == "talana_buk":
        parsed = parse_talana_buk(text, period_month)
    elif fmt == "dealsy":
        parsed = parse_dealsy(text, period_month)
    elif fmt == "nuevo_chile":
        parsed = parse_nuevo_chile(text, period_month)
    elif fmt == "axity":
        parsed = parse_axity(text, period_month)
    elif fmt == "unholster_scan":
        parsed = parse_unholster_scan(text, period_month)
    else:
        raise ValueError(f"unsupported format: {fmt}")
    parsed["source_pdf"] = rel_source_pdf(path)
    return parsed


def cache_path_for_pdf(path: Path) -> Path:
    digest = pdf_bytes_sha256(path)
    return PARSE_CACHE_PER_PDF_DIR / f"{digest}.json"


def load_cache(path: Path, version: str) -> Optional[Dict[str, Any]]:
    cache_file = cache_path_for_pdf(path)
    if not cache_file.is_file():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if data.get("parser_version") != version:
        return None
    if data.get("source_pdf") != rel_source_pdf(path):
        return None
    return data.get("parsed")


def write_cache(path: Path, version: str, parsed: Dict[str, Any]) -> None:
    PARSE_CACHE_PER_PDF_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = cache_path_for_pdf(path)
    payload = {
        "parser_version": version,
        "source_pdf": rel_source_pdf(path),
        "pdf_sha256": pdf_bytes_sha256(path),
        "parsed": parsed,
    }
    cache_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def list_pdf_paths() -> List[Path]:
    if not LIQUIDACIONES_DIR.is_dir():
        raise RuntimeError(f"liquidaciones dir not found: {LIQUIDACIONES_DIR}")
    return sorted(LIQUIDACIONES_DIR.rglob("*.pdf"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Parse Chilean payroll liquidación PDFs")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--force-reparse", action="store_true")
    ap.add_argument("--skip", action="append", default=[], help="relative path under cfraser/")
    args = ap.parse_args()

    skip_set = {s.replace("\\", "/") for s in args.skip}
    version = parser_version_hash()
    pdfs = list_pdf_paths()
    print(f"Found {len(pdfs)} PDF(s) under {LIQUIDACIONES_DIR}")

    parsed_rows: List[Dict[str, Any]] = []
    failures: List[str] = []
    skipped: List[str] = []

    for path in pdfs:
        rel = rel_source_pdf(path)
        if rel in skip_set:
            skipped.append(rel)
            continue
        use_cache = not args.no_cache and not args.force_reparse
        cached = load_cache(path, version) if use_cache else None
        if cached is not None:
            parsed_rows.append(cached)
            continue
        try:
            parsed = parse_payroll_pdf(path)
            write_cache(path, version, parsed)
            parsed_rows.append(parsed)
            print(f"  ok {rel} liquido={parsed['liquido_clp']:,} ({parsed['format']})")
        except Exception as e:
            failures.append(f"{rel}: {e}")
            print(f"  FAIL {rel}: {e}", file=sys.stderr)

    index_path = PARSE_CACHE_DIR / "all.json"
    PARSE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    index_path.write_text(
        json.dumps(
            {
                "parser_version": version,
                "count": len(parsed_rows),
                "skipped": skipped,
                "failures": failures,
                "rows": parsed_rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote {index_path} ({len(parsed_rows)} parsed, {len(failures)} failed, {len(skipped)} skipped)")

    if failures:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
