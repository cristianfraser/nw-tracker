#!/usr/bin/env python3
"""Parse staged Lider «Boleta Digital» PDFs into per-boleta parsed.json files.

Usage (repo root):
  python3 server/scripts/parse-lider-boletas.py            # parse new/changed staged boletas
  python3 server/scripts/parse-lider-boletas.py --check    # parse everything, write nothing
  python3 server/scripts/parse-lider-boletas.py --force    # re-parse all

Two templates exist in the corpus (2025-07 → today):
  * store: compact lines — `CODIGO: <ean>` then `3X3.490  DESC $ 1x.xxx`, or a single
    `<ean> DESC $ 850` line; totals block SUBTOTAL/TOTAL AFECTO/…/TOTAL $.
  * delivery (lider.cl domicilio): columnar — EAN alone on a line, then `4x3.290  DESC $1x.xxx`;
    totals TOTAL NETO / TOTAL IVA; may pay partially with «PESOS MICLUB CANJEADOS».

Discount lines (`RF …  -520`, `DESCUENTO …  -3.990`) attach to the preceding item. Payments are
collected as legs (TARJETA LIDER BCI / LIDERBCI, EFECTIVO net of VUELTO, MICLUB canjeados) and
the parse FAILS unless sum(items) - sum(discounts) == sum(payments) — a boleta that does not
balance must surface, not import.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STAGED_DIR = REPO_ROOT / "cfraser" / "lider-boletas" / "staged"

PARSER_VERSION = 1

RE_SUC = re.compile(r"^\s*SUC:\s*(.+?)\s*$")
RE_CITY = re.compile(r"^\s*([A-ZÑÁÉÍÓÚ .]+?)(?:\s*-\s*([A-ZÑÁÉÍÓÚ .]+?))?\s*$")
RE_RUT = re.compile(r"RUT|^\s*\d{8}-[\dkK]\s*$")
RE_BOL = re.compile(r"Bol\.?\s*Electronica:\s*(\d+)\s+Caja:\s*(\d+)")
RE_FECHA = re.compile(r"Fecha:\s*(\d{2})/(\d{2})/(\d{4})\s+Hora:\s*(\d{2}:\d{2}:\d{2})")
RE_CODIGO = re.compile(r"^\s*CODIGO:\s*(\d+)\s*$")
RE_EAN_ALONE = re.compile(r"^\s*(\d{7,14})\s*$")
RE_QTY_ITEM = re.compile(r"^\s*(\d+)[Xx]([\d.]+)\s+(.*?)\s*\$\s*([\d.]+)\s*$")
RE_SINGLE_ITEM = re.compile(r"^\s*(\d{7,14})\s+(.+?)\s*\$\s*([\d.]+)\s*$")
RE_DISCOUNT = re.compile(r"^\s*(RF .*?|DESCUENTO .*?)\s+\$?\s*-\s*([\d.]+)\s*$")
# Weighted item continuation: `x 1.744 KG` (dot is the DECIMAL here, unlike peso amounts).
RE_WEIGHT = re.compile(r"^\s*x\s+(\d+\.\d+)(?:\s*KG)?\s*$")
RE_TOTALS_START = re.compile(r"^\s*(SUBTOTAL|TOTAL AFECTO|TOTAL NETO|PESOS MICLUB CANJEADOS)\b")
RE_PAY_CARD = re.compile(r"^\s*TARJETA LIDER ?BCI\s*\$?\s*([\d.]+)\s*$")
RE_PAY_EFECTIVO = re.compile(r"^\s*EFECTIVO\s*\$?\s*([\d.]+)\s*$")
RE_PAY_MICLUB = re.compile(r"^\s*PESOS MICLUB CANJEADOS\s*\$?\s*([\d.]+)\s*$")
# A boleta paid with another card goes through Transbank: items stored, no Lider-card movement.
RE_PAY_TBK = re.compile(r"^\s*TBK (CREDITO|DEBITO)\s*\$?\s*([\d.]+)\s*$")
RE_VUELTO = re.compile(r"^\s*VUELTO\s*\$?\s*([\d.]+)\s*$")
RE_TOTAL_PRINTED = re.compile(r"^\s*TOTAL\s*\$\s*([\d.]+)\s*$")
RE_ARTIC = re.compile(r"TOTAL NUMERO DE ARTIC VEND\s*=\s*(\d+)")
RE_MI_CLUB_POINTS = re.compile(r"^\s*MI CLUB(?: TARJETA LIDER ?BCI)?\s*\$\s*([\d.]+)\s*$", re.M)
RE_COLUMN_HEADER = re.compile(r"^\s*(CANT\s+PRECIO|CODIGO\s+DESC\.|-{5,})")


def clp(raw: str) -> int:
    return int(raw.replace(".", ""))


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
    payments: list[dict]
    total_printed_clp: int | None
    articles_declared: int | None
    mi_club_points: int | None


class BoletaParseError(Exception):
    pass


def parse_boleta_text(text: str) -> Parsed:
    lines = text.split("\n")

    bol = RE_BOL.search(text)
    fecha = RE_FECHA.search(text)
    if not bol or not fecha:
        raise BoletaParseError("missing Bol. Electronica / Fecha header")
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
        raise BoletaParseError("missing SUC: line")

    template = "delivery" if re.search(r"CANT\s+PRECIO UNITARIO", text) else "store"

    # Items: from the Fecha line to the first totals marker.
    fecha_idx = next(i for i, l in enumerate(lines) if RE_FECHA.search(l))
    items: list[Item] = []
    pending_barcode: str | None = None
    end_idx = len(lines)
    for i in range(fecha_idx + 1, len(lines)):
        line = lines[i]
        if RE_TOTALS_START.match(line):
            end_idx = i
            break
        stripped = line.strip()
        if not stripped or RE_COLUMN_HEADER.match(line):
            continue
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
                raise BoletaParseError(f"weight line with no preceding item: {stripped!r}")
            weight = m.group(1)
            it = items[-1]
            if it.qty != "1" or it.qty_unit != "un":
                raise BoletaParseError(f"weight line after a non-single item: {stripped!r}")
            it.qty = weight
            it.qty_unit = "kg"
            it.unit_price_clp = round(it.total_clp / float(weight))
            continue
        m = RE_DISCOUNT.match(line)
        if m:
            label, amount = m.group(1).strip(), clp(m.group(2))
            if not items:
                raise BoletaParseError(f"discount line with no preceding item: {stripped!r}")
            items[-1].discount_clp += amount
            items[-1].discount_labels.append(label)
            continue
        raise BoletaParseError(f"unrecognised line in item section: {stripped!r}")

    if not items:
        raise BoletaParseError("no items parsed")

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
        raise BoletaParseError("no payment legs found")

    artic = RE_ARTIC.search(text)
    points = RE_MI_CLUB_POINTS.search(text)

    items_sum = sum(i.total_clp for i in items) - sum(i.discount_clp for i in items)
    pay_sum = sum(p["amount_clp"] for p in payments)
    if items_sum != pay_sum:
        raise BoletaParseError(f"does not balance: items-discounts={items_sum} vs payments={pay_sum}")
    if total_printed is not None and total_printed != pay_sum and total_printed != items_sum:
        # Store template's printed TOTAL is the full purchase; with a single card leg they match.
        raise BoletaParseError(f"printed TOTAL {total_printed} != payments {pay_sum}")

    return Parsed(
        boleta_number=bol.group(1),
        caja=bol.group(2),
        sucursal=sucursal,
        city=city,
        purchased_at=purchased_at,
        template=template,
        items=items,
        payments=payments,
        total_printed_clp=total_printed,
        articles_declared=int(artic.group(1)) if artic else None,
        mi_club_points=clp(points.group(1)) if points else None,
    )


def pdftotext(pdf: Path) -> str:
    r = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True)
    if r.returncode != 0:
        raise BoletaParseError(f"pdftotext failed: {r.stderr.strip()}")
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="parse everything, write nothing")
    ap.add_argument("--force", action="store_true", help="re-parse even when parsed.json is current")
    args = ap.parse_args()

    if not STAGED_DIR.is_dir():
        print(f"no staged boletas ({STAGED_DIR})")
        return 0

    ok = 0
    failed: list[tuple[str, str]] = []
    skipped = 0
    for d in sorted(STAGED_DIR.iterdir()):
        pdf = d / "Boleta.pdf"
        if not d.is_dir() or not pdf.is_file():
            continue
        out = d / "parsed.json"
        if out.is_file() and not args.force and not args.check:
            try:
                if json.loads(out.read_text()).get("parser_version") == PARSER_VERSION:
                    skipped += 1
                    continue
            except Exception:
                pass
        try:
            parsed = parse_boleta_text(pdftotext(pdf))
        except BoletaParseError as e:
            failed.append((d.name, str(e)))
            continue
        if not args.check:
            payload = asdict(parsed)
            payload["parser_version"] = PARSER_VERSION
            out.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
        ok += 1

    print(f"parsed ok={ok} skipped={skipped} failed={len(failed)}")
    for name, err in failed:
        print(f"  FAIL {name}: {err}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
