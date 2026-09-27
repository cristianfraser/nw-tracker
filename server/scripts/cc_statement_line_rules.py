"""Which part of a credit-card statement a parsed line belongs to — one rule set for Python and TS.

The rules live in `server/src/ccStatementLineRules.json`, read here and by
`server/src/ccStatementLineRules.ts`, so the parse-time reconcile (`cc_statement_reconcile.py`)
and the import-time reconcile (`ccStatementImportReconcile.ts`) sum a statement the same way.
`server/src/test/ccStatementLineSectionCases.json` is asserted by both test suites.

A non-installment line goes to one of:

- ``operaciones``: a purchase (section 1, «Total operaciones»).
- ``cargos_abonos``: section 3 (interest, fees, taxes, notas de crédito, the USD side's
  «ABONO DE DIVISAS»).
- ``mid_period_payments``: a payment printed as a line (the compact / OCR payment layouts, and
  BCI's section-3 PAGO rows).
- ``ignored``: counted nowhere (a payment or refund outside those layouts).
- ``skip``: a garbled international row (two pdftotext lines merged) — not a real line.

A missing or malformed rules file raises: it is committed, so its absence is a broken checkout.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List

import cc_cards

RULES_PATH = Path(__file__).resolve().parent.parent / "src" / "ccStatementLineRules.json"

_KEYS = (
    "payment_merchants",
    "usd_debt_abono_merchant",
    "traspaso_deuda_tokens",
    "clp_section3_charge_pattern",
    "usd_section3_pattern",
    "usd_garbled_merchant_pattern",
    "usd_garbled_merchant_markers",
    "mid_period_payment_layouts",
    "section3_charge_layouts",
    "bci_section3_layouts",
)


def _load() -> dict:
    data = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    unknown = sorted(set(data) - set(_KEYS))
    missing = sorted(set(_KEYS) - set(data))
    if unknown or missing:
        raise SystemExit(
            f"{RULES_PATH}: unknown keys: {', '.join(unknown) or '-'}; "
            f"missing keys: {', '.join(missing) or '-'}"
        )
    return data


RULES = _load()

PAYMENT_MERCHANTS = frozenset(RULES["payment_merchants"])
USD_DEBT_ABONO_MERCHANT: str = RULES["usd_debt_abono_merchant"]
TRASPASO_DEUDA_TOKENS: List[str] = RULES["traspaso_deuda_tokens"]
RE_CLP_SECTION3_CHARGE = re.compile(RULES["clp_section3_charge_pattern"], re.I)
RE_USD_SECTION3 = re.compile(RULES["usd_section3_pattern"], re.I)
RE_USD_GARBLED_MERCHANT = re.compile(RULES["usd_garbled_merchant_pattern"], re.I)
USD_GARBLED_MERCHANT_MARKERS: List[str] = RULES["usd_garbled_merchant_markers"]
MID_PERIOD_PAYMENT_LAYOUTS = frozenset(RULES["mid_period_payment_layouts"])
SECTION3_CHARGE_LAYOUTS = frozenset(RULES["section3_charge_layouts"])
BCI_SECTION3_LAYOUTS = frozenset(RULES["bci_section3_layouts"])


def norm_merchant(merchant: object) -> str:
    """Trim, uppercase, collapse whitespace — `normCcMerchant` in `ccDedupeKey.ts`."""
    return re.sub(r"\s+", " ", str(merchant or "").strip().upper())


def is_payment_merchant(merchant: object) -> bool:
    """Exact PAGO / MONTO CANCELADO / ABONO — `isCcPaymentMerchant` in `ccPaymentLines.ts`."""
    m = norm_merchant(merchant)
    return bool(m) and m in PAYMENT_MERCHANTS


def is_usd_debt_abono_merchant(merchant: object) -> bool:
    """«ABONO DE DIVISAS»: the payment of the USD debt (some formats suffix it)."""
    return USD_DEBT_ABONO_MERCHANT in norm_merchant(merchant)


def is_traspaso_deuda_merchant(merchant: object) -> bool:
    """A traspaso de deuda: USD debt moved onto the CLP side of the same card."""
    m = str(merchant or "").strip().upper()
    return all(tok in m for tok in TRASPASO_DEUDA_TOKENS)


def is_clp_section3_merchant(merchant: object) -> bool:
    m = str(merchant or "").strip()
    if is_payment_merchant(m):
        return False
    return bool(RE_CLP_SECTION3_CHARGE.search(m))


def is_usd_section3_merchant(merchant: object, amount_usd: float) -> bool:
    """Section 3 of an international statement. Payments stay out: on the legacy USD format the
    printed section-3 total excludes the MONTO CANCELADO rows (they sit in «ABONO REALIZADO»)."""
    m = str(merchant or "").strip().upper()
    if not m:
        return False
    if is_usd_debt_abono_merchant(m):
        return True
    if is_payment_merchant(m):
        return False
    if amount_usd <= 0:
        return True
    return bool(RE_USD_SECTION3.search(m))


def is_garbled_usd_merchant(merchant: object) -> bool:
    """Merged pdftotext lines (a page counter «… DE 2» glued onto a merchant) with a wrong US$."""
    m = str(merchant or "").upper()
    if RE_USD_GARBLED_MERCHANT.search(m):
        return True
    if any(marker in m for marker in USD_GARBLED_MERCHANT_MARKERS):
        return True
    return any(tok.upper() in m for tok in cc_cards.MULTICARD_MARKER_TOKENS)


def classify_statement_line(currency: str, merchant: object, layout: str, amount: float) -> str:
    """Section of a non-installment line (see the module docstring for the section names)."""
    if str(currency or "clp").lower() == "usd":
        if is_garbled_usd_merchant(merchant):
            return "skip"
        if is_usd_section3_merchant(merchant, amount):
            return "cargos_abonos"
        return "operaciones" if amount > 0 else "ignored"
    lay = str(layout or "")
    if lay in MID_PERIOD_PAYMENT_LAYOUTS:
        return "mid_period_payments"
    if lay in SECTION3_CHARGE_LAYOUTS:
        return "cargos_abonos"
    if lay in BCI_SECTION3_LAYOUTS:
        # BCI section-3 rows carry their own layout: the merchant patterns are Santander-shaped
        # and miss BCI's forms («IMPUESTO DL 3475», merchant-named notas), which the bank nets
        # into Monto Total Facturado. Its PAGO rows are payments.
        return "mid_period_payments" if is_payment_merchant(merchant) else "cargos_abonos"
    if is_clp_section3_merchant(merchant):
        return "cargos_abonos"
    return "operaciones" if amount > 0 else "ignored"
