"""
Tesseract OCR for image-scan Santander / BCI credit-card statement PDFs.

Used when `pdftotext` / pypdf yield no readable text layer (macOS Preview saves, scans).
Requires: poppler, tesseract, pymupdf in `server/scripts/.pdf_deps`.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

CC_PDF_OCR_DPI = int(os.environ.get("CC_PDF_OCR_DPI", "400"))

RE_OCR_INTL_ROW = re.compile(
    r"(\d{2}/\d{2}/\d{2})\s+(.+?)\s+([\d.]+,\d{2})\s+([\d.,]+)"
    r"(?=\s*(?:\[)?\d{2}/\d{2}/\d{2}\b|\s*[«>]|Santander|EMISOR|COMPROBANTE|MOVIMIENTOS|$)",
    re.I,
)
RE_OCR_INTL_NOTA_ROW = re.compile(
    r"(\d{2}/\d{2}/\d{2})\s*[\]\|]\s*NOTA\s+DE\s+CREDITO",
    re.I,
)
# Santander CLP scan: `SANTIAGO 29/01/21] JUMBO BILBAO $47.930` or `29/01/21]ENEL INTERNET $36.313`
RE_OCR_CLP_CHARGE = re.compile(
    r"(?:SANTIAGO\s+)?(\d{2}/\d{2}/\d{2})\s*[\]\|]\s*([^$]+?)\s+\$\s*(-?[\d.]+)",
    re.I,
)
# Payments: `30/01/21] MONTO CANCELADO $ -2.764.457` (date-before-amount; do not use amount-before-date — OCR often glues `amt| nextDate]`).
RE_OCR_CLP_PAYMENT_AFTER = re.compile(
    r"(\d{2}/\d{2}/\d{2})\s*[\]\|]\s*(MONTO\s+CANCELADO)\s+\$\s*(-?[\d.]+)",
    re.I,
)
RE_OCR_PERIOD_PAIR = re.compile(
    r"PER[IÍ]ODO\s+FACTURADO[^\d]*(\d{2}/\d{2}/\d{4})[^\d]*(\d{2}/\d{2}/\d{4})",
    re.I,
)
RE_OCR_PERIOD_DESDE_HASTA = re.compile(
    r"PER[IÍ]ODO\s+FACTURADO\s+DESDE\s+(\d{2}/\d{2}/\d{4}).*?"
    r"PER[IÍ]ODO\s+FACTURADO\s+HASTA\s+(\d{2}/\d{2}/\d{4})",
    re.I | re.S,
)


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


def extract_cc_pdf_ocr_flat(pdf_path: Path) -> str:
    import fitz  # type: ignore

    prefix = tessdata_prefix()
    if prefix:
        os.environ.setdefault("TESSDATA_PREFIX", prefix)
    if not shutil.which("tesseract"):
        raise RuntimeError(
            "Tesseract is required for image-scan credit-card PDFs. Install: brew install tesseract"
        )

    doc = fitz.open(str(pdf_path))
    chunks: List[str] = []
    try:
        for page in doc:
            tp = page.get_textpage_ocr(dpi=CC_PDF_OCR_DPI, full=True)
            words = [w[4] for w in tp.extractWORDS()]
            if words:
                chunks.append(" ".join(words))
    finally:
        doc.close()
    return re.sub(r"\s+", " ", " ".join(chunks)).strip()


def peek_pdf_text_pdftotext(path: Path) -> str:
    try:
        return subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return ""


def peek_pdf_text_with_ocr_fallback(path: Path) -> str:
    """pdftotext first; OCR flat text when the PDF has no text layer."""
    text = peek_pdf_text_pdftotext(path).strip()
    if text:
        return text
    return extract_cc_pdf_ocr_flat(path)


def fill_meta_billing_from_ocr_flat(meta: Dict[str, object], flat: str) -> None:
    """Fill period_from / period_to / pay_by when OCR glues tokens on one line."""
    if not str(meta.get("period_from") or "").strip() or not str(meta.get("period_to") or "").strip():
        m = RE_OCR_PERIOD_PAIR.search(flat)
        if m:
            if not str(meta.get("period_from") or "").strip():
                meta["period_from"] = m.group(1)
            if not str(meta.get("period_to") or "").strip():
                meta["period_to"] = m.group(2)
    if not str(meta.get("period_from") or "").strip() or not str(meta.get("period_to") or "").strip():
        m2 = RE_OCR_PERIOD_DESDE_HASTA.search(flat)
        if m2:
            if not str(meta.get("period_from") or "").strip():
                meta["period_from"] = m2.group(1)
            if not str(meta.get("period_to") or "").strip():
                meta["period_to"] = m2.group(2)
    if not str(meta.get("pay_by") or "").strip():
        m3 = re.search(r"PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})", flat, re.I)
        if m3:
            meta["pay_by"] = m3.group(1)


def parse_usd_amount_ocr(raw: str) -> Optional[float]:
    t = str(raw or "").strip().replace(" ", "")
    if not t:
        return None
    if "," in t and "." not in t:
        t = t.replace(",", ".")
    t = t.replace(",", "")
    try:
        return float(t)
    except ValueError:
        return None


def parse_clp_amount_ocr(raw: str) -> Optional[int]:
    t = str(raw or "").strip().replace("$", "").replace(" ", "")
    if not t:
        return None
    neg = t.startswith("-")
    t = t.lstrip("-")
    t = t.replace(".", "")
    try:
        v = int(t)
    except ValueError:
        return None
    return -v if neg else v


def parse_international_usd_ocr_flat(
    flat: str,
    *,
    build_intl_row,
    intl_merchant_is_noise,
) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    seen: set[Tuple[str, float, str]] = set()

    def add_row(row: Optional[Dict[str, object]]) -> None:
        if not row:
            return
        key = (
            str(row.get("transaction_date") or ""),
            round(float(row.get("amount_usd") or 0), 4),
            str(row.get("merchant") or "").upper(),
        )
        if key in seen:
            return
        seen.add(key)
        out.append(row)

    for m in RE_OCR_INTL_ROW.finditer(flat):
        fecha = m.group(1)
        merchant = m.group(2).strip()
        if intl_merchant_is_noise(merchant):
            continue
        country_m = re.search(r"\b([A-Z]{2,3})\s+[\d.]+,\d{2}\s*$", merchant, re.I)
        country = country_m.group(1).upper() if country_m else ""
        merchant_clean = re.sub(r"\s+[A-Z]{2,3}\s*$", "", merchant).strip()
        add_row(
            build_intl_row(
                fecha,
                merchant_clean,
                country or "NL",
                m.group(3),
                m.group(4),
            )
        )

    for m in RE_OCR_INTL_NOTA_ROW.finditer(flat):
        fecha = m.group(1)
        tail = flat[m.end() : m.end() + 100]
        amts = re.findall(r"(\d+,\d{2})", tail)
        if not amts:
            continue
        usd_raw = f"-{amts[-1]}"
        add_row(
            build_intl_row(
                fecha,
                "NOTA DE CREDITO",
                "US",
                usd_raw,
                usd_raw,
            )
        )

    return out


def parse_santander_clp_ocr_flat(
    flat: str,
    *,
    compact_row_from_parts,
    compact_payment_merchant_re,
) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    seen: set[Tuple[str, int, str]] = set()

    def add_row(fecha: str, merchant: str, amt: int, layout: str, place: str = "") -> None:
        key = (fecha, amt, merchant.upper())
        if key in seen:
            return
        seen.add(key)
        out.append(
            compact_row_from_parts(
                fecha=fecha,
                merchant=merchant,
                amt=amt,
                layout=layout,
                description_raw=f"{place} {merchant}".strip() if place else merchant,
                place=place,
            )
        )

    for m in RE_OCR_CLP_CHARGE.finditer(flat):
        fecha, merchant, amt_raw = m.group(1), m.group(2).strip(), m.group(3)
        merchant = re.sub(r"\s+", " ", merchant).strip(" -|")
        if not merchant or "MONTO CANCELADO" in merchant.upper():
            continue
        if "MOVIMIENTOS TARJETA" in merchant.upper() or "MASTERCARD $" in merchant.upper():
            continue
        amt = parse_clp_amount_ocr(amt_raw)
        if amt is None or compact_payment_merchant_re.match(merchant):
            continue
        add_row(fecha, merchant, amt, "ocr_compact")

    for m in RE_OCR_CLP_PAYMENT_AFTER.finditer(flat):
        fecha, merchant, amt_raw = m.group(1), m.group(2), m.group(3)
        amt = parse_clp_amount_ocr(amt_raw)
        if amt is None:
            continue
        add_row(fecha, merchant, amt, "ocr_payment")

    return out
