"""Chain registry + dispatch: receipt text → `Parsed` for whichever chain printed it.

The chain is detected from what the receipt prints, never a filename: the issuer RUT in the
header — the one field every Chilean boleta carries — or, when a photo lost it (a cropped top)
or the OCR misread it, the issuer's printed legal name. A RUT and a name naming two different
chains, a receipt naming none, or a registered chain whose parser is not written yet raises:
the receipt must surface, never be parsed as the wrong chain.

Directives: a hand-corrected text (`ocr.corrected.txt`) may carry `#! key: value` lines, which
are not receipt text. `#! purchase_date: YYYY-MM-DD` declares the date of a receipt that prints
none (a cropped photo); it never overrides a printed date — the two disagreeing raises.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from grocery_receipt_jumbo import parse_jumbo_text
from grocery_receipt_lider import parse_lider_text
from grocery_receipt_model import Parsed, ReceiptParseError

# `RUT: 76.134.946-5` (store template) or the bare RUT alone on a header line
# (`76134941-4` — the delivery template prints it under the issuer's address, unlabelled).
RE_RUT = re.compile(r"\bRUT\s*:?\s*(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK])|^\s*(\d{7,8}-[\dkK])\s*$", re.M)


def normalize_rut(raw: str) -> str:
    return raw.replace(".", "").upper()


@dataclass(frozen=True)
class Chain:
    slug: str
    # Every issuer RUT the chain prints (one company can bill through several entities).
    ruts: tuple[str, ...]
    # The issuer's legal name as printed in the header (compared letters and digits only).
    names: tuple[str, ...]
    parser: Callable[[str], Parsed] | None


CHAINS: tuple[Chain, ...] = (
    # Walmart Chile — Lider / Express de Lider / lider.cl. 76.134.946-5 on the Express and
    # store boletas, 76.134.941-4 on the hipermercado (Buenaventura) and lider.cl delivery ones.
    # Its boletas print no issuer legal name.
    Chain("lider", ("76134946-5", "76134941-4"), (), parse_lider_text),
    # Cencosud Retail S.A. — Jumbo (2018 → today) / Santa Isabel.
    Chain("jumbo", ("81201000-K",), ("CENCOSUD RETAIL S.A.",), parse_jumbo_text),
)
CHAINS_BY_RUT = {rut: c for c in CHAINS for rut in c.ruts}


def _name_key(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", s.upper())


CHAINS_BY_NAME = {_name_key(n): c for c in CHAINS for n in c.names}


def _chain_by_name(text: str) -> Chain | None:
    """The chain whose issuer name opens a line (an OCR row may carry more text after it)."""
    found: set[Chain] = set()
    for line in text.split("\n"):
        key = _name_key(line)
        found.update(chain for name_key, chain in CHAINS_BY_NAME.items() if key.startswith(name_key))
    if len(found) > 1:
        raise ReceiptParseError(f"the receipt prints the names of several chains: {sorted(c.slug for c in found)}")
    return next(iter(found), None)


def detect_chain(text: str) -> Chain:
    by_name = _chain_by_name(text)
    m = RE_RUT.search(text)
    rut = normalize_rut(m.group(1) or m.group(2)) if m else None
    by_rut = CHAINS_BY_RUT.get(rut) if rut else None
    if by_rut and by_name and by_rut is not by_name:
        raise ReceiptParseError(f"issuer RUT {rut} is {by_rut.slug} but the printed name is {by_name.slug}")
    chain = by_rut or by_name
    if chain:
        return chain
    if rut:
        raise ReceiptParseError(f"unknown chain: issuer RUT {rut} is not in the registry")
    raise ReceiptParseError("no issuer RUT or issuer name found in the receipt text")


RE_DIRECTIVE = re.compile(r"^\s*#!\s*([a-z_]+)\s*:\s*(.*?)\s*$")
DIRECTIVES = {"purchase_date"}


def split_directives(text: str) -> tuple[str, dict[str, str]]:
    """(receipt text without `#!` lines, their key → value). An unknown key raises."""
    directives: dict[str, str] = {}
    kept: list[str] = []
    for line in text.split("\n"):
        m = RE_DIRECTIVE.match(line)
        if not m:
            kept.append(line)
            continue
        key, value = m.group(1), m.group(2)
        if key not in DIRECTIVES:
            raise ReceiptParseError(f"unknown directive #! {key} (known: {', '.join(sorted(DIRECTIVES))})")
        directives[key] = value
    return "\n".join(kept), directives


def parse_receipt_text(text: str) -> Parsed:
    text, directives = split_directives(text)
    chain = detect_chain(text)
    if chain.parser is None:
        raise ReceiptParseError(
            f"{chain.slug}: receipt recognised by its issuer RUT but no parser exists yet — "
            f"write grocery_receipt_{chain.slug}.py against this receipt"
        )
    parsed = chain.parser(text)
    parsed.chain = chain.slug
    parsed.purchase_date_source = "printed" if parsed.purchased_at else None
    declared = directives.get("purchase_date")
    if declared is not None:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", declared):
            raise ReceiptParseError(f"#! purchase_date must be YYYY-MM-DD, got {declared!r}")
        if parsed.purchased_at and parsed.purchased_at[:10] != declared:
            raise ReceiptParseError(
                f"#! purchase_date {declared} disagrees with the printed date {parsed.purchased_at[:10]}"
            )
        if not parsed.purchased_at:
            parsed.purchased_at = f"{declared} 00:00:00"
            parsed.purchase_date_source = "declared"
    return parsed
