"""Copy of `server/scripts/statement_values.py` for the parsers that moved to ingest
(docs/ingest-split-plan.md); both copies are pinned by the same case tables until the server's
last parser goes.

Dates and peso amounts as bank and payroll documents print them — one parser for every script.

- `parse_dd_mm_yy_to_iso` mirrors `parseDdMmYyToIso` in `server/src/ccInstallmentPayBy.ts`;
  `server/src/test/ddMmYyToIsoCases.json` is asserted by both test suites.
- `parse_clp_amount` reads a printed peso amount.
- `parse_chilean_decimal` reads a printed decimal amount the way `parseChileanNumber` in
  `server/src/chileanNumber.ts` does; `server/src/test/chileanDecimalCases.json` is asserted by
  both test suites.
"""
from __future__ import annotations

import re
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Optional

RE_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
RE_DD_MM_YY = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})", re.ASCII)
# pypdf can merge DD/MM/YY with the MCC digits that follow (13/05/25 + 11001SANTIAG).
TX_DATE_MIN_PLAUSIBLE_YEAR = 1990
TX_DATE_MAX_PLAUSIBLE_YEAR = 2038

RE_CLP_AMOUNT = re.compile(r"(-?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?", re.ASCII)


def repair_jammed_year(raw: object) -> str:
    """A four-digit year outside 1990-2038 is a two-digit year jammed with the next digits:
    keep its first two digits (`13/05/2511` → `13/05/25`). Anything else comes back trimmed."""
    t = str(raw or "").strip()
    m = RE_DD_MM_YY.fullmatch(t)
    if not m:
        return t
    ypart = m.group(3)
    if len(ypart) == 2:
        return t
    if TX_DATE_MIN_PLAUSIBLE_YEAR <= int(ypart) <= TX_DATE_MAX_PLAUSIBLE_YEAR:
        return t
    return f"{m.group(1)}/{m.group(2)}/{ypart[:2]}"


def parse_dd_mm_yy_to_iso(raw: object) -> Optional[str]:
    """`DD/MM/YY` or `DD/MM/YYYY` (one- or two-digit day and month) → `YYYY-MM-DD`; None when the
    text is not such a date. Two-digit years pivot at 70 (`69` → 2069, `70` → 1970); an ISO date
    passes through. Day and month are range-checked, not calendar-checked."""
    t = repair_jammed_year(raw)
    if RE_ISO_DATE.fullmatch(t):
        return t
    m = RE_DD_MM_YY.fullmatch(t)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 1900 if y >= 70 else 2000
    return iso_date_from_parts(d, mo, y)


def iso_date_from_parts(day: int, month: int, year: int) -> Optional[str]:
    """`YYYY-MM-DD` when day is 1-31 and month 1-12 (range-checked, not calendar-checked)."""
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def parse_clp_amount(raw: object) -> Optional[int]:
    """A printed peso amount → int; None when the text is not one.

    Chilean printing: dots group thousands (`1.234.567`), a leading `-` is negative, `$` and
    whitespace are ignored (`$ -50.000`, OCR's `1 600`). A decimal part after one comma rounds to
    the nearest peso, ties to even (`12.990,00` → 12990, `10,50` → 10).

    Pesos have no cents: the documents that print decimals in a peso amount (the international
    statement's origin-amount column for CLP purchases, two payroll liquidaciones) print `,00`.
    A non-zero fraction only arrives when the card parser tries a dollar amount as pesos;
    ties-to-even is what the stored rows of those attempts already carry, so a stricter rule
    (None) would rewrite them.

    Documents that group thousands with commas (some payroll providers print `1,126,500`)
    convert to this form before calling (see `parse-payroll-liquidaciones.py`)."""
    t = re.sub(r"\s+", "", str(raw or "")).replace("$", "")
    m = RE_CLP_AMOUNT.fullmatch(t)
    if not m:
        return None
    sign, whole, frac = m.groups()
    value = Decimal(f"{whole.replace('.', '')}.{frac or '0'}").to_integral_value(
        rounding=ROUND_HALF_EVEN
    )
    n = int(value)
    return -n if sign else n


def parse_chilean_decimal(raw: object) -> Optional[float]:
    """A printed decimal amount → float; None when the text is not one.

    Chilean printing: dots group thousands, the comma is the decimal (`20.604,00` → 20604.0,
    `3,99` → 3.99, `-12,00` → -12.0); whitespace is ignored. Unlike `parse_clp_amount` the
    decimals are kept: the international statement's origin-amount column prints pesos, dollars
    and euros alike, and which one it is is decided from the value (`ccOriginCurrency.ts`).

    Stricter than `parseChileanNumber` about grouping (`12.34` is not an amount here, there it is
    1234), so any text this reads, that one reads the same."""
    t = re.sub(r"\s+", "", str(raw or ""))
    m = RE_CLP_AMOUNT.fullmatch(t)
    if not m:
        return None
    sign, whole, frac = m.groups()
    value = float(Decimal(f"{whole.replace('.', '')}.{frac or '0'}"))
    return -value if sign else value
