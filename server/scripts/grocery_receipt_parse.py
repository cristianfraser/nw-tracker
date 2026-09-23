"""Chain registry + dispatch: receipt text → `Parsed` for whichever chain printed it.

The chain is detected from the issuer RUT printed in the receipt header — the one field every
Chilean boleta carries and no filename or e-mail sender needs to vouch for. A RUT not in the
registry, or a registered chain whose parser is not written yet, raises: the receipt must
surface, never be parsed as the wrong chain.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

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
    parser: Callable[[str], Parsed] | None


CHAINS: tuple[Chain, ...] = (
    # Walmart Chile — Lider / Express de Lider / lider.cl. 76.134.946-5 on the Express and
    # store boletas, 76.134.941-4 on the hipermercado (Buenaventura) and lider.cl delivery ones.
    Chain("lider", ("76134946-5", "76134941-4"), parse_lider_text),
    # Cencosud Retail S.A. — Jumbo / Santa Isabel. Registered so the first receipt fails with a
    # named chain instead of "unknown RUT"; the parser is written against that first receipt.
    Chain("jumbo", ("81201000-K",), None),
)
CHAINS_BY_RUT = {rut: c for c in CHAINS for rut in c.ruts}


def detect_chain(text: str) -> Chain:
    m = RE_RUT.search(text)
    if not m:
        raise ReceiptParseError("no issuer RUT found in the receipt text")
    rut = normalize_rut(m.group(1) or m.group(2))
    chain = CHAINS_BY_RUT.get(rut)
    if not chain:
        raise ReceiptParseError(f"unknown chain: issuer RUT {rut} is not in the registry")
    return chain


def parse_receipt_text(text: str) -> Parsed:
    chain = detect_chain(text)
    if chain.parser is None:
        raise ReceiptParseError(
            f"{chain.slug}: receipt recognised by its issuer RUT but no parser exists yet — "
            f"write grocery_receipt_{chain.slug}.py against this receipt"
        )
    parsed = chain.parser(text)
    parsed.chain = chain.slug
    return parsed
