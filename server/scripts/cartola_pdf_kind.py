"""Classify Santander checking vs cuenta vista (CUENTAMATICA) cartola PDF text."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Optional, Tuple

RE_CARTOLA_SIN_MOVIMIENTOS = re.compile(
    r"\*\*\s*CARTOLA\s+SIN\s+MOVIMIENTOS\s*\*\*", re.I
)

RE_PERIOD_PAIR = re.compile(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})")
RE_CARTOLA_HEADER = re.compile(
    r"0323-M-C-0[01]\s+(\d+)\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})",
    re.I,
)


def dd_mm_yyyy_to_iso(raw: str) -> Optional[str]:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def is_cuenta_vista_cartola_text(text: str) -> bool:
    """True for CUENTAMATICA / cuenta vista layout (not generic 'Cuenta Vista' in movements)."""
    upper = text.upper()
    if "CUENTAMATICA" in upper or "ESTADO CUENTAMATICA" in upper:
        return True
    if "ESTADO CUENTA VISTA" in upper:
        return True
    if "MOVIMIENTO DE SU CUENTA" in upper:
        return True
    if "0-000-00-00002" in upper:
        return True
    return False


def is_linea_credito_cartola_text(text: str) -> bool:
    """Santander CTA CTE CREDITO / línea de crédito cartola (not tarjeta de crédito)."""
    upper = text.upper()
    if "CTA CTE CREDITO" in upper or "CUENTA CORRIENTE CREDITO" in upper:
        return True
    # NOT a bare "LINEA DE CREDITO" test: every cuenta corriente cartola prints an
    # "INFORMACION DE LA LINEA DE CREDITO" summary block, so that substring matched the ML
    # cartolas too — and because `is_checking_cartola_text` rejects anything this returns True
    # for, it silently disqualified them from the header peek and they were filed under the
    # constant date in the attachment filename (a July-2026 cartola landed as 2021-12-24).
    # A genuine línea de crédito cartola always carries "CTA CTE CREDITO" (verified across the
    # corpus), so the strong markers alone are sufficient.
    if "0-010-12-57000-3" in upper:
        return True
    return False


def is_checking_cartola_text(text: str) -> bool:
    """True for cuenta corriente cartolas (DETALLE DE MOVIMIENTOS), including misfiled vista names."""
    if is_cuenta_vista_cartola_text(text) or is_linea_credito_cartola_text(text):
        return False
    upper = text.upper()
    if "DETALLE DE MOVIMIENTOS" in upper:
        return True
    if "0-000-71-20626" in upper and "CARTOLA" in upper:
        return True
    return False


def peek_cartola_hasta_and_no(text: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (period_to ISO date, cartola number) from cartola header."""
    cartola_no: Optional[str] = None
    period_to: Optional[str] = None

    cm = RE_CARTOLA_HEADER.search(re.sub(r"\s+", " ", text))
    if cm:
        cartola_no = cm.group(1)
        period_to = dd_mm_yyyy_to_iso(cm.group(3))

    if not period_to:
        pm = RE_PERIOD_PAIR.search(text)
        if pm:
            period_to = dd_mm_yyyy_to_iso(pm.group(2))

    if not period_to:
        dates = re.findall(r"\b(\d{2}/\d{2}/\d{4})\b", text)
        if len(dates) >= 2:
            period_to = dd_mm_yyyy_to_iso(dates[-1])

    if not cartola_no:
        m = re.search(r"CARTOLA\s+(\d+)", text, re.I)
        if m:
            cartola_no = m.group(1)

    return period_to, cartola_no


def text_indicates_cartola_sin_movimientos(text: str) -> bool:
    return bool(RE_CARTOLA_SIN_MOVIMIENTOS.search(str(text or "")))


def peek_cartola_pdf_sin_movimientos(path: Path) -> bool:
    try:
        raw = subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return False
    return text_indicates_cartola_sin_movimientos(raw)


def incoming_vista_cartola_replaces_dest(existing: Path, incoming: Path) -> bool:
    """
    True when `existing` on disk is a sin-movimientos cartola and `incoming` is not
    (new PDF should replace the filed copy).
    """
    if not existing.is_file() or not incoming.is_file():
        return False
    if existing.resolve() == incoming.resolve():
        return False
    return peek_cartola_pdf_sin_movimientos(existing) and not peek_cartola_pdf_sin_movimientos(
        incoming
    )


RE_CARTOLA_ACCOUNT = re.compile(r"\b(\d-\d{3}-\d{2}-\d{5}-\d)\b")


def peek_cartola_account(text: str) -> Optional[str]:
    """
    The account a cartola belongs to, as printed in its header (`0-000-00-00001-1`).

    Two different accounts can produce cartolas for the same period with the same cartola number
    (Santander leaves it blank on cuenta vista), so the period alone does not identify a document.
    Without this the second one to arrive was archived as a duplicate of the first — the two
    cuenta vista accounts in the corpus have been sharing one filename space.
    """
    m = RE_CARTOLA_ACCOUNT.search(text)
    return m.group(1) if m else None


def peek_cartola_pdf_account(path) -> Optional[str]:
    """`peek_cartola_account` over a PDF on disk; None when the text cannot be extracted."""
    try:
        raw = subprocess.check_output(
            ["pdftotext", "-layout", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return None
    return peek_cartola_account(raw)
