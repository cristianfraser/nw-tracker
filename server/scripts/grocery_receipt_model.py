"""Shared shapes for grocery receipt parsers (one module per chain, dispatched by
`grocery_receipt_parse.py`). Chain parsers return a `Parsed`; the CLI serialises it to the
staged dir's parsed.json, which `groceryReceiptsImport.ts` reads."""
from __future__ import annotations

import re
from dataclasses import dataclass, field


class ReceiptParseError(Exception):
    pass


def clp(raw: str) -> int:
    """Peso amount as printed (`14.320`). Receipts never print decimals, so every separator is a
    thousands separator — an OCR that reads `.` as `,` must not change the value."""
    digits = re.sub(r"[.,]", "", raw)
    if not digits.isdigit():
        raise ReceiptParseError(f"not a peso amount: {raw!r}")
    return int(digits)


@dataclass
class Item:
    position: int
    barcode: str | None
    description: str
    # Decimal string: "3" for unit items, "1.744" for weighted (kg) ones.
    qty: str
    qty_unit: str  # "un" | "kg"
    # For kg items this is the derived per-kg price (total / weight, rounded).
    unit_price_clp: int
    total_clp: int
    discount_clp: int = 0
    discount_labels: list[str] = field(default_factory=list)


@dataclass
class Parsed:
    boleta_number: str
    caja: str
    sucursal: str
    city: str | None
    purchased_at: str
    template: str
    items: list[Item]
    receipt_discounts: list[dict]
    payments: list[dict]
    total_printed_clp: int | None
    articles_declared: int | None
    mi_club_points: int | None
    # Set by the dispatcher (`parse_receipt_text`), never by a chain parser.
    chain: str = ""
    # Digit-less lines met inside the item section and skipped (pre-printed marketing text
    # that OCR picks up on a paper receipt). Provenance for the report — never silent.
    ignored_lines: list[str] = field(default_factory=list)
