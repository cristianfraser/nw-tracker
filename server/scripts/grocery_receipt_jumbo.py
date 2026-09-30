"""Jumbo (Cencosud Retail S.A.) receipt text → `Parsed`.

One template across the corpus (2018 → 2026), reached as photos of the paper boleta (OCR text):

    RUT 81201000-K
    BOLETA ELECTRONICA Nº 3474837223
    SII SANTIAGO ORIENTE
    CENCOSUD RETAIL S.A.
    AV. KENNEDY 9001, LAS CONDES-SANTIAGO      ← the issuer's head office (newer boletas)
    AV. A. BELLO 2447 LOCAL 1000               ← the store
    PROVIDENCIA - SANTIAGO                     ← comuna - city
    2 X $3.590                                 ← quantity line: belongs to the next item
    7801610220023 PAK  7.180
    JUMBO OFERTAS  -349                        ← a discount: belongs to the item above
    0,378 KG X $14.890                         ← a weighed item's weight and per-kg price
    2496814056285 BISTEC POSTA PALET 5.628
    SUB TOTAL $ 65.805 · NETO · TOTAL IVA · DESCUENTOS $ 1.388 · TOTAL $ 64.417
    T. CREDITO $ 64.417 · VUELTO $ 0
    … PUNTOS CENCOSUD block, and on newer boletas the card slip with `26/09/26 17:02`.

Older photos are often cropped: no RUT line (the chain comes from the printed issuer name), no
receipt number (the import keys the receipt on the photo), no date (the import resolves it).

Fail-fast, like the Lider parser: Σ items must equal SUB TOTAL, Σ discounts the printed
DESCUENTOS (0 when none is printed), SUB TOTAL − DESCUENTOS the printed TOTAL, and the payment
legs net of VUELTO the same total; every quantity line must multiply out to the amount of the
item it binds to (a weighed one to within a peso of rounding). OCR tolerance is deliberately
narrow, and every item code must pass its EAN-13 check digit (a misread digit changes which
product a line is): `.` and `,` are both thousands separators, but spaces never join digits — «BOLSA 1  990»
is a description ending in 1 and an amount of 990 — so a thousands separator the OCR lost is
fixed in `ocr.corrected.txt`, never guessed. A correction writes `?` for an item code the photo
lost (a thumb over the column): the item imports without a barcode rather than a guessed one. Digit-less lines in the item section (a promo
banner the OCR picked up) are skipped and reported; any other line that is not an item, a
quantity, a discount or a known label raises.
"""
from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal

from grocery_receipt_model import Item, Parsed, ReceiptParseError, clp

# An amount at the end of a line: `990`, `7.180`, `1,890`, `46.486`, OCR `4  .499`.
AMT = r"\d{1,3}(?:\s*[.,]\s*\d{3})+|\d{1,3}"
RE_BOLETA = re.compile(r"ELECTRONICA\s*N\S*\s*(\d{8,})")
RE_ISSUER = re.compile(r"^\s*CENCOSUD\s+RETAIL\s+S\.?\s*A\.?", re.I)
RE_HEAD_OFFICE = re.compile(r"KENNEDY\s+9001")
RE_CITY = re.compile(r"^\s*([A-ZÑÁÉÍÓÚ][A-ZÑÁÉÍÓÚ .]*?)\s+-\s+([A-ZÑÁÉÍÓÚ][A-ZÑÁÉÍÓÚ .]*?)\s*$")
RE_HEADER_NOISE = re.compile(r"^\s*(RUT\b|SII\b|BOLETA\b|\*)")
# Quantity lines, possibly followed on the same OCR row by the neighbouring row's text.
RE_QTY_UNITS = re.compile(rf"^\s*(\d+)\s*X\s*\$\s*({AMT})(?=\s|$)\s*(.*)$")
RE_QTY_KG = re.compile(rf"^\s*(\d+),(\d{{3}})\s*KG\s*X\s*\$\s*({AMT})(?=\s|$)\s*(.*)$")
# `?` in place of the code: a correction file marks a code the photo lost (never OCR output).
RE_ITEM = re.compile(rf"^\s*(\d{{8,14}}|\?)\s+(.+?)\s+\$?\s*({AMT})\s*$")
RE_DISCOUNT = re.compile(rf"^\s*([A-ZÑ][^\d$]*?)\s+-\s*\$?\s*({AMT})\s*$")
RE_SUBTOTAL = re.compile(rf"^\s*SUB\s*TOTAL\s*\$?\s*({AMT})\s*$")
RE_DESCUENTOS = re.compile(rf"^\s*DESCUENTOS\s*\$?\s*({AMT})\s*$")
RE_TOTAL = re.compile(rf"^\s*TOTAL\s*\$?\s*({AMT})\s*$")
RE_PAYMENT = re.compile(rf"^\s*(T\.\s*CREDITO|T\.\s*DEBITO|EFECTIVO|GIFT\s*CARD)\s*\$?\s*({AMT})\s*$")
RE_VUELTO = re.compile(rf"^\s*VUELTO\s*\$?\s*({AMT})\s*$")
RE_IGNORED_TOTAL_LINE = re.compile(r"^\s*(NETO|TOTAL\s+IVA)\b")
# The PUNTOS CENCOSUD banner (always opened by asterisks, however the OCR reads its words) or the
# lines that follow it.
RE_TOTALS_END = re.compile(r"^\s*\*|PUNTOS\s*CENCOSUD|USTED PODRIA|^\s*NOMBRE\s*:|SALDO DE PUNTOS", re.I)
# The card slip / TRX block: `26/09/26 17:02` or `17/09/26 13:46:42`.
RE_DATETIME = re.compile(r"\b(\d{2})/(\d{2})/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\b")
RE_HAS_DIGIT = re.compile(r"\d")

PAYMENT_METHODS = {"TCREDITO": "t_credito", "TDEBITO": "t_debito", "EFECTIVO": "efectivo", "GIFTCARD": "gift_card"}


def _amt(raw: str) -> int:
    """A printed peso amount; the OCR may leave a gap around the separator (`4  .499`)."""
    return clp(re.sub(r"\s+", "", raw))


def ean13_ok(code: str) -> bool:
    """EAN-13 check digit — every Jumbo item code is one (in-store weighed codes included)."""
    if len(code) != 13 or not code.isdigit():
        return False
    d = [int(c) for c in code]
    return (10 - sum(d[i] * (3 if i % 2 else 1) for i in range(12)) % 10) % 10 == d[12]


def _kg_total(weight: Decimal, per_kg: int) -> int:
    return int((weight * per_kg).quantize(Decimal(1), rounding=ROUND_HALF_UP))


class _Pending:
    """A quantity line waiting for the item it describes. One alone on its row describes the very
    next item; one the OCR merged into a neighbouring row may bind one item later (the merged row
    is often the item ABOVE it)."""

    def __init__(self, qty: str, unit: str, price: int, raw: str, alone: bool):
        self.qty, self.unit, self.price, self.raw, self.alone = qty, unit, price, raw, alone
        self.items_passed = 0

    def total(self) -> int:
        return int(self.qty) * self.price if self.unit == "un" else _kg_total(Decimal(self.qty), self.price)

    def fits(self, amount: int) -> bool:
        # A weighed item's printed amount is the rounded product; allow the peso either way.
        return abs(self.total() - amount) <= (1 if self.unit == "kg" else 0)


def _header(lines: list[str]) -> tuple[str, str | None, int]:
    """(store address, comuna - city line, index of the first line after the header)."""
    issuer = next((i for i, l in enumerate(lines) if RE_ISSUER.match(l)), None)
    if issuer is None:
        raise ReceiptParseError("jumbo: missing the CENCOSUD RETAIL S.A. line")
    city_idx = None
    for i in range(issuer + 1, min(issuer + 6, len(lines))):
        if RE_CITY.match(lines[i]):
            city_idx = i
            break
    if city_idx is None:
        raise ReceiptParseError("jumbo: no «comuna - city» line under the issuer")
    store = [
        l.strip()
        for l in lines[issuer + 1 : city_idx]
        if l.strip() and not RE_HEAD_OFFICE.search(l) and not RE_HEADER_NOISE.match(l)
    ]
    if len(store) != 1:
        raise ReceiptParseError(f"jumbo: expected one store address line above the city, got {store!r}")
    return re.sub(r"\s+", " ", store[0]), re.sub(r"\s+", " ", lines[city_idx].strip()), city_idx + 1


def parse_jumbo_text(text: str) -> Parsed:
    lines = text.split("\n")
    boleta = RE_BOLETA.search(text)
    sucursal, city, start = _header(lines)

    items: list[Item] = []
    receipt_discounts: list[dict] = []
    ignored: list[str] = []
    pending: list[_Pending] = []
    end = None

    def take_item(barcode: str | None, desc: str, amount: int) -> None:
        qty, unit, price = "1", "un", amount
        match = next((p for p in pending if p.fits(amount)), None)
        if match is not None:
            pending.remove(match)
            qty, unit, price = match.qty, match.unit, match.price
        for p in pending:
            p.items_passed += 1
            if p.alone or p.items_passed > 1:
                raise ReceiptParseError(
                    f"jumbo: quantity line {p.raw!r} ({p.total()}) fits no item where it prints "
                    f"(next item: {desc!r} {amount})"
                )
        items.append(Item(len(items), barcode, desc, qty, unit, price, amount))

    for i in range(start, len(lines)):
        rest = lines[i].strip()
        if RE_SUBTOTAL.match(rest):
            end = i
            break
        if not rest:
            continue
        # A quantity line opens the row; the OCR may have merged the neighbouring row's text
        # after it, which is then read as a line of its own.
        m = RE_QTY_UNITS.match(rest) or RE_QTY_KG.match(rest)
        if m:
            if m.re is RE_QTY_UNITS:
                qty, unit, price, tail = m.group(1), "un", _amt(m.group(2)), m.group(3).strip()
            else:
                qty, unit, price, tail = f"{int(m.group(1))}.{m.group(2)}", "kg", _amt(m.group(3)), m.group(4).strip()
            pending.append(_Pending(qty, unit, price, rest, alone=not tail))
            rest = tail
            if not rest:
                continue
        m = RE_ITEM.match(rest)
        if m:
            code = None if m.group(1) == "?" else m.group(1)
            if code is not None and not ean13_ok(code):
                # A digit the OCR misread or lost: the product identity is wrong, never import it.
                raise ReceiptParseError(f"jumbo: item code {m.group(1)} fails the EAN-13 check digit: {rest!r}")
            take_item(code, re.sub(r"\s+", " ", m.group(2).strip()), _amt(m.group(3)))
            continue
        m = RE_DISCOUNT.match(rest)
        if m:
            label, amount = re.sub(r"\s+", " ", m.group(1).strip()), _amt(m.group(2))
            if items:
                items[-1].discount_clp += amount
                items[-1].discount_labels.append(label)
            else:
                receipt_discounts.append({"label": label, "amount_clp": amount})
            continue
        if not RE_HAS_DIGIT.search(rest):
            ignored.append(rest)
            continue
        raise ReceiptParseError(f"jumbo: unrecognised line in item section: {rest!r}")

    if end is None:
        raise ReceiptParseError("jumbo: no SUB TOTAL line")
    if pending:
        raise ReceiptParseError(f"jumbo: quantity line {pending[0].raw!r} binds to no item")
    if not items:
        raise ReceiptParseError("jumbo: no items parsed")

    subtotal = _amt(RE_SUBTOTAL.match(lines[end].strip()).group(1))
    descuentos: int | None = None
    total: int | None = None
    vuelto = 0
    payments: list[dict] = []
    for line in lines[end + 1 :]:
        s = line.strip()
        if RE_TOTALS_END.search(s):
            break
        if not s or RE_IGNORED_TOTAL_LINE.match(s):
            continue
        if (m := RE_DESCUENTOS.match(s)) is not None:
            descuentos = _amt(m.group(1))
        elif (m := RE_TOTAL.match(s)) is not None:
            total = _amt(m.group(1))
        elif (m := RE_PAYMENT.match(s)) is not None:
            method = PAYMENT_METHODS[re.sub(r"[^A-Z]", "", m.group(1).upper())]
            payments.append({"method": method, "amount_clp": _amt(m.group(2))})
        elif (m := RE_VUELTO.match(s)) is not None:
            vuelto = _amt(m.group(1))
        else:
            raise ReceiptParseError(f"jumbo: unrecognised line in the totals: {s!r}")

    items_sum = sum(it.total_clp for it in items)
    if items_sum != subtotal:
        raise ReceiptParseError(f"jumbo: items sum to {items_sum}, SUB TOTAL prints {subtotal}")
    discount_sum = sum(it.discount_clp for it in items) + sum(d["amount_clp"] for d in receipt_discounts)
    if discount_sum != (descuentos or 0):
        raise ReceiptParseError(f"jumbo: discounts sum to {discount_sum}, DESCUENTOS prints {descuentos or 0}")
    if total is None:
        raise ReceiptParseError("jumbo: no TOTAL line")
    if subtotal - discount_sum != total:
        raise ReceiptParseError(f"jumbo: SUB TOTAL {subtotal} − DESCUENTOS {discount_sum} ≠ TOTAL {total}")
    if not payments:
        raise ReceiptParseError("jumbo: no payment line")
    if vuelto:
        cash = next((p for p in payments if p["method"] == "efectivo"), None)
        if cash is None:
            raise ReceiptParseError(f"jumbo: VUELTO {vuelto} without a cash payment")
        cash["amount_clp"] -= vuelto
    paid = sum(p["amount_clp"] for p in payments)
    if paid != total:
        raise ReceiptParseError(f"jumbo: payments net {paid} ≠ TOTAL {total}")

    dt = RE_DATETIME.search("\n".join(lines[end:]))
    purchased_at = (
        f"20{dt.group(3)}-{dt.group(2)}-{dt.group(1)} {dt.group(4)}:{dt.group(5)}:{dt.group(6) or '00'}" if dt else None
    )
    return Parsed(
        boleta_number=boleta.group(1) if boleta else None,
        caja="",
        sucursal=sucursal,
        city=city,
        purchased_at=purchased_at,
        template="jumbo",
        items=items,
        receipt_discounts=receipt_discounts,
        payments=payments,
        total_printed_clp=total,
        articles_declared=None,
        mi_club_points=None,
        ignored_lines=ignored,
    )
