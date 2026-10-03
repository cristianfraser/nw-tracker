"""Lider (Walmart Chile) receipt text → `Parsed`.

Two templates exist in the corpus (2025-07 → today), both reached as e-mail «Boleta Digital»
PDFs (pdftotext -layout) and — since 2026-09 — as photos of the paper boleta (OCR text, same
store layout plus a «COMPROBANTE VENTA LIDER BCI» block):
  * store: compact lines — `CODIGO: <ean>` then `3X3.490  DESC $ 1x.xxx`, or a single
    `<ean> DESC $ 850` line; totals block SUBTOTAL/TOTAL AFECTO/…/TOTAL $.
  * delivery (lider.cl domicilio): columnar — EAN alone on a line, then `4x3.290  DESC $1x.xxx`;
    totals TOTAL NETO / TOTAL IVA; may pay partially with «PESOS MICLUB CANJEADOS».

Discounts come in two scopes and MUST not be conflated (a receipt-level rebate folded into
the last item corrupts that product's effective price): a discount line printed DIRECTLY under
an item (no blank line) is product info and attaches to it (`RF Precio Antes Ahora`, `RF Lleve
N x $`, per-unit `DESCUENTO RNR`, a fee's own `DESCUENTO DESPACHO`); a discount separated from
the last item by a blank line — `RF CANJE PESOS MCL` (Mi Club points redeemed), `RF 10% DSCTO
BCI CUPON` — is receipt-level and lands in `receipt_discounts`. `CANJE PESOS MCL` is forced
receipt-level regardless of position (points are never product info). Payments are collected
as legs (TARJETA LIDER BCI / LIDERBCI, EFECTIVO net of VUELTO, MICLUB canjeados) and the parse
FAILS unless sum(items) - item discounts - receipt discounts == sum(payments), AND unless the
printed «TOTAL NUMERO DE ARTIC VEND» equals the item count (unit items by qty, each weighed
item once — true on the whole PDF corpus) — a boleta that does not balance must surface, not
import.

OCR tolerance (paper photos), each backed by the fail-fast checks above: the `$` before an
amount is optional (the glyph is the one thing Apple Vision misreads on thermal paper), `,` and
`.` are both thousands separators, and digit-less lines inside the item section are skipped
and reported (`ignored_lines`) — every real line there carries a code, a quantity or an amount;
the PDF corpus has none, so on a PDF this tolerance is never exercised.
"""
from __future__ import annotations

import re

from grocery_receipt_model import Item, Parsed, ReceiptParseError, clp

RE_SUC = re.compile(r"^\s*SUC:\s*(.+?)\s*$")
RE_CITY = re.compile(r"^\s*([A-ZÑÁÉÍÓÚ .]+?)(?:\s*-\s*([A-ZÑÁÉÍÓÚ .]+?))?\s*$")
RE_RUT = re.compile(r"RUT|^\s*\d{8}-[\dkK]\s*$")
RE_BOL = re.compile(r"Bol\.?\s*Electronica:\s*(\d+)\s+Caja:\s*(\d+)")
RE_FECHA = re.compile(r"Fecha:\s*(\d{2})/(\d{2})/(\d{4})\s+Hora:\s*(\d{2}:\d{2}:\d{2})")
RE_CODIGO = re.compile(r"^\s*CODIGO:\s*(\d+)\s*$")
RE_EAN_ALONE = re.compile(r"^\s*(\d{7,14})\s*$")
AMT = r"[\d.,]+"
# `(?:\$\s*)?` — the peso sign is optional (OCR); the amount is what identifies the line.
RE_QTY_ITEM = re.compile(rf"^\s*(\d+)[Xx]({AMT})\s+(.*?)\s*(?:\$\s*)?({AMT})\s*$")
RE_SINGLE_ITEM = re.compile(rf"^\s*(\d{{7,14}})\s+(.+?)\s*(?:\$\s*)?({AMT})\s*$")
RE_DISCOUNT = re.compile(rf"^\s*(RF .*?|DESCUENTO .*?)\s+\$?\s*-\s*({AMT})\s*$")
# Weighted item continuation: `x 1.744 KG` (dot is the DECIMAL here, unlike peso amounts).
RE_WEIGHT = re.compile(r"^\s*x\s+(\d+\.\d+)(?:\s*KG)?\s*$")
RE_TOTALS_START = re.compile(r"^\s*(SUBTOTAL|TOTAL AFECTO|TOTAL NETO|PESOS MICLUB CANJEADOS)\b")
RE_PAY_CARD = re.compile(rf"^\s*TARJETA LIDER ?BCI\s*\$?\s*({AMT})\s*$")
RE_PAY_EFECTIVO = re.compile(rf"^\s*EFECTIVO\s*\$?\s*({AMT})\s*$")
RE_PAY_MICLUB = re.compile(rf"^\s*PESOS MICLUB CANJEADOS\s*\$?\s*({AMT})\s*$")
# A boleta paid with another card goes through Transbank: items stored, no Lider-card movement.
RE_PAY_TBK = re.compile(rf"^\s*TBK (CREDITO|DEBITO)\s*\$?\s*({AMT})\s*$")
RE_VUELTO = re.compile(rf"^\s*VUELTO\s*\$?\s*({AMT})\s*$")
RE_TOTAL_PRINTED = re.compile(rf"^\s*TOTAL\s*(?:\$\s*)?({AMT})\s*$")
RE_ARTIC = re.compile(r"TOTAL NUMERO DE ARTIC VEND\s*=\s*(\d+)")
# E-mail PDF: `ACUMULACION` on its own line, then `MI CLUB TARJETA LIDER BCI $ 1713`; paper:
# `ACUMULACION MI CLUB T.LIDERBCI $ 858` on one line.
RE_MI_CLUB_POINTS = re.compile(
    rf"^\s*(?:ACUMULACION\s+)?MI CLUB(?:\s+(?:TARJETA LIDER ?BCI|T\.LIDER ?BCI))?\s*\$\s*({AMT})\s*$", re.M
)
RE_COLUMN_HEADER = re.compile(r"^\s*(CANT\s+PRECIO|CODIGO\s+DESC\.|-{5,})")
RE_HAS_DIGIT = re.compile(r"\d")


def parse_lider_text(text: str) -> Parsed:
    lines = text.split("\n")

    bol = RE_BOL.search(text)
    fecha = RE_FECHA.search(text)
    if not bol or not fecha:
        raise ReceiptParseError("missing Bol. Electronica / Fecha header")
    purchased_at = f"{fecha.group(3)}-{fecha.group(2)}-{fecha.group(1)} {fecha.group(4)}"

    sucursal: str | None = None
    city: str | None = None
    for i, line in enumerate(lines):
        m = RE_SUC.match(line)
        if m:
            sucursal = m.group(1)
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if nxt and not RE_RUT.search(nxt) and not RE_BOL.search(nxt) and RE_CITY.match(nxt):
                city = nxt
            break
    if not sucursal:
        raise ReceiptParseError("missing SUC: line")

    template = "delivery" if re.search(r"CANT\s+PRECIO UNITARIO", text) else "store"

    # Items: from the Fecha line to the first totals marker.
    fecha_idx = next(i for i, l in enumerate(lines) if RE_FECHA.search(l))
    items: list[Item] = []
    receipt_discounts: list[dict] = []
    ignored_lines: list[str] = []
    pending_barcode: str | None = None
    blank_since_entry = True
    end_idx = len(lines)
    for i in range(fecha_idx + 1, len(lines)):
        line = lines[i]
        if RE_TOTALS_START.match(line):
            end_idx = i
            break
        stripped = line.strip()
        if not stripped or RE_COLUMN_HEADER.match(line):
            blank_since_entry = True
            continue
        was_blank = blank_since_entry
        blank_since_entry = False
        m = RE_CODIGO.match(line) or (RE_EAN_ALONE.match(line) if template == "delivery" else None)
        if m:
            pending_barcode = m.group(1)
            continue
        m = RE_QTY_ITEM.match(line)
        if m:
            qty, unit, desc, total = int(m.group(1)), clp(m.group(2)), m.group(3).strip(), clp(m.group(4))
            items.append(Item(len(items), pending_barcode, desc, str(qty), "un", unit, total))
            pending_barcode = None
            continue
        m = RE_SINGLE_ITEM.match(line)
        if m:
            barcode, desc, total = m.group(1), m.group(2).strip(), clp(m.group(3))
            items.append(Item(len(items), barcode, desc, "1", "un", total, total))
            pending_barcode = None
            continue
        m = RE_WEIGHT.match(line)
        if m:
            if not items:
                raise ReceiptParseError(f"weight line with no preceding item: {stripped!r}")
            weight = m.group(1)
            it = items[-1]
            if it.qty != "1" or it.qty_unit != "un":
                raise ReceiptParseError(f"weight line after a non-single item: {stripped!r}")
            it.qty = weight
            it.qty_unit = "kg"
            it.unit_price_clp = round(it.total_clp / float(weight))
            continue
        m = RE_DISCOUNT.match(line)
        if m:
            label, amount = m.group(1).strip(), clp(m.group(2))
            # Receipt scope: blank-line-separated from the last item (both templates print
            # product promos directly under their item), no item yet, or a Mi Club canje —
            # points redemptions are never product info, wherever they print.
            receipt_scope = was_blank or not items or "CANJE PESOS MCL" in label.upper()
            if receipt_scope:
                receipt_discounts.append({"label": label, "amount_clp": amount})
            else:
                items[-1].discount_clp += amount
                items[-1].discount_labels.append(label)
            continue
        if not RE_HAS_DIGIT.search(stripped):
            # Pre-printed marketing text OCR'd off the paper (never on a PDF): skip, report.
            ignored_lines.append(stripped)
            blank_since_entry = was_blank
            continue
        raise ReceiptParseError(f"unrecognised line in item section: {stripped!r}")

    if not items:
        raise ReceiptParseError("no items parsed")

    # Payments + trailing metadata (scan the totals section onward; stop before the Mi Club
    # comprobante block reprints TOTAL/card lines without amounts context).
    payments: list[dict] = []
    total_printed: int | None = None
    vuelto = 0
    for line in lines[end_idx:]:
        if "COMPROBANTE" in line or "** MI CLUB **" in line:
            break
        m = RE_PAY_CARD.match(line)
        if m:
            payments.append({"method": "tarjeta_lider_bci", "amount_clp": clp(m.group(1))})
            continue
        m = RE_PAY_EFECTIVO.match(line)
        if m:
            payments.append({"method": "efectivo", "amount_clp": clp(m.group(1))})
            continue
        m = RE_PAY_MICLUB.match(line)
        if m:
            payments.append({"method": "miclub", "amount_clp": clp(m.group(1))})
            continue
        m = RE_PAY_TBK.match(line)
        if m:
            payments.append({"method": f"tbk_{m.group(1).lower()}", "amount_clp": clp(m.group(2))})
            continue
        m = RE_VUELTO.match(line)
        if m:
            vuelto = clp(m.group(1))
            continue
        m = RE_TOTAL_PRINTED.match(line)
        if m:
            total_printed = clp(m.group(1))
            continue
    # Delivery template prints MICLUB canjeados BEFORE the totals marker cut; re-scan whole text.
    if not any(p["method"] == "miclub" for p in payments):
        m = RE_PAY_MICLUB.search(text)
        if m and RE_PAY_MICLUB.match(m.group(0)):
            payments.append({"method": "miclub", "amount_clp": clp(m.group(1))})
    if vuelto:
        for p in payments:
            if p["method"] == "efectivo":
                p["amount_clp"] -= vuelto
                break

    if not payments:
        raise ReceiptParseError("no payment legs found")

    artic = RE_ARTIC.search(text)
    points = RE_MI_CLUB_POINTS.search(text)

    items_sum = (
        sum(i.total_clp for i in items)
        - sum(i.discount_clp for i in items)
        - sum(d["amount_clp"] for d in receipt_discounts)
    )
    pay_sum = sum(p["amount_clp"] for p in payments)
    if items_sum != pay_sum:
        raise ReceiptParseError(f"does not balance: items-discounts={items_sum} vs payments={pay_sum}")
    if total_printed is not None and total_printed != pay_sum and total_printed != items_sum:
        # Store template's printed TOTAL is the full purchase; with a single card leg they match.
        raise ReceiptParseError(f"printed TOTAL {total_printed} != payments {pay_sum}")
    articles_declared = int(artic.group(1)) if artic else None
    if articles_declared is not None:
        articles_parsed = sum(int(i.qty) if i.qty_unit == "un" else 1 for i in items)
        if articles_parsed != articles_declared:
            raise ReceiptParseError(
                f"article count: printed {articles_declared} vs parsed {articles_parsed} — a line was lost or duplicated"
            )

    return Parsed(
        boleta_number=bol.group(1),
        caja=bol.group(2),
        sucursal=sucursal,
        city=city,
        purchased_at=purchased_at,
        template=template,
        items=items,
        receipt_discounts=receipt_discounts,
        payments=payments,
        total_printed_clp=total_printed,
        articles_declared=articles_declared,
        mi_club_points=clp(points.group(1)) if points else None,
        ignored_lines=ignored_lines,
    )
