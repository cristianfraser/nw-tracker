"""Layout helpers for `cfraser/credit-card-statements/<card>/clp|usd/`."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Iterator

CLP_SLOT = "clp"
USD_SLOT = "usd"
UNREADABLE_DIR = "unreadable"
# Folder under credit-card-statements/ (successor master); PDF stem may keep predecessor last4.
SANTANDER_CC_SLOT_REDIRECT = {
    "4113": "4141",
    "4114": "4141",
    "4111": "4242",
    "4112": "4242",
}
RE_ORGANIZED_CC = re.compile(r"^\d{4}-\d{2}-\d{2} ", re.I)
RE_NUMBERED_COPY = re.compile(r"\s*\(\d+\)\.pdf$", re.I)
RE_CC_STEM = re.compile(
    r"^(?P<iso>\d{4}-\d{2}-\d{2}) estado de cuenta tarjeta(?: usd)?(?: (?P<suffix>\d{4}|n\d+|legacy|usd))?$",
    re.I,
)


def is_organized_cc_pdf_name(name: str) -> bool:
    return bool(RE_ORGANIZED_CC.match(name))


def strip_numbered_copy_suffix(filename: str) -> str:
    return re.sub(r"\s*\(\d+\)(?=\.pdf$)", "", filename, flags=re.I)


def pdf_text_is_international_usd(pdf: Path) -> bool:
    try:
        text = subprocess.check_output(
            ["pdftotext", str(pdf), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return False
    return "ESTADO DE CUENTA INTERNACIONAL" in text.upper()


def parse_organized_cc_stem(stem: str) -> dict[str, object] | None:
    """Parse `YYYY-MM-DD estado de cuenta tarjeta[ usd][ suffix]` (stem only)."""
    clean = re.sub(r"\s*\(\d+\)$", "", stem).strip()
    m = RE_CC_STEM.match(clean)
    if not m:
        return None
    iso = m.group("iso")
    suffix = (m.group("suffix") or "").strip()
    lower = clean.lower()
    usd = " tarjeta usd " in f" {lower} " or lower.endswith(" usd")
    card_key = suffix if suffix else None
    if card_key == "usd" and not usd:
        usd = True
    return {"iso": iso, "usd": usd, "card_key": card_key}


def cc_slot_name(usd: bool) -> str:
    return USD_SLOT if usd else CLP_SLOT


def cc_slot_key(card_key: str) -> str:
    return SANTANDER_CC_SLOT_REDIRECT.get(str(card_key).strip(), str(card_key).strip())


def cc_slot_dir(cc_root: Path, card_key: str, usd: bool) -> Path:
    return cc_root / cc_slot_key(card_key) / cc_slot_name(usd)


def cc_dest_path(cc_root: Path, card_key: str, usd: bool, stem: str) -> Path:
    folder = cc_slot_dir(cc_root, card_key, usd)
    clean_stem = re.sub(r"\s*\(\d+\)$", "", stem).strip()
    return folder / f"{clean_stem}.pdf"


def pdf_already_in_card_slot(cc_root: Path, pdf: Path) -> bool:
    try:
        rel = pdf.relative_to(cc_root)
    except ValueError:
        return False
    parts = rel.parts
    if len(parts) != 3:
        return False
    _card, slot, _name = parts
    return slot in (CLP_SLOT, USD_SLOT)


def iter_cc_statement_pdfs(cc_root: Path) -> Iterator[Path]:
    if not cc_root.is_dir():
        return
    for path in sorted(cc_root.rglob("*.pdf")):
        if UNREADABLE_DIR in path.parts:
            continue
        yield path


def clean_numbered_copy_filenames(cc_root: Path, *, dry_run: bool) -> int:
    """Drop ` (n)` when a plain sibling exists; otherwise rename to the plain name."""
    changed = 0
    for entry in iter_cc_statement_pdfs(cc_root):
        if not RE_NUMBERED_COPY.search(entry.name):
            continue
        plain_name = strip_numbered_copy_suffix(entry.name)
        plain = entry.parent / plain_name
        if plain.is_file() and plain.resolve() != entry.resolve():
            print(f"remove duplicate: {entry.relative_to(cc_root.parent)}")
            if not dry_run:
                entry.unlink()
            changed += 1
            continue
        print(f"rename: {entry.name} -> {plain_name}")
        if not dry_run:
            entry.rename(plain)
        changed += 1
    return changed


def relocate_cc_pdf_to_card_slot(cc_root: Path, pdf: Path, *, dry_run: bool) -> bool:
    """Move an organized CC PDF into `<card>/clp|usd/` when it is not already there."""
    if pdf_already_in_card_slot(cc_root, pdf):
        return False
    meta = parse_organized_cc_stem(pdf.stem)
    if not meta:
        return False
    card_key = meta.get("card_key")
    if not card_key or not isinstance(card_key, str):
        card_key = "legacy"
    usd = bool(meta["usd"]) or pdf_text_is_international_usd(pdf)
    dest = cc_dest_path(cc_root, card_key, usd, pdf.stem)
    if usd and " usd " not in f" {dest.stem.lower()} ":
        dest = cc_dest_path(
            cc_root,
            card_key,
            True,
            f"{meta['iso']} estado de cuenta tarjeta usd {card_key}",
        )
    if pdf.resolve() == dest.resolve():
        return False
    if dest.exists() and pdf.resolve() != dest.resolve():
        print(f"skip (exists): {dest.relative_to(cc_root.parent)}")
        if not dry_run:
            pdf.unlink()
        return True
    print(f"{pdf.relative_to(cc_root.parent)} -> {dest.relative_to(cc_root.parent)}")
    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
        pdf.rename(dest)
    return True


def relocate_all_cc_pdfs_to_card_slots(cc_root: Path, *, dry_run: bool) -> int:
    moved = 0
    for pdf in list(iter_cc_statement_pdfs(cc_root)):
        if relocate_cc_pdf_to_card_slot(cc_root, pdf, dry_run=dry_run):
            moved += 1
    return moved
