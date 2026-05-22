#!/usr/bin/env python3
"""
Rename/move statement PDFs under cfraser/ to:

  credit-card-statements/YYYY-MM-DD estado de cuenta tarjeta[ usd][ suffix].pdf
  cartolas-cuenta-corriente/YYYY-MM-DD cartola cuenta corriente [tag].pdf

Uses `cc-statements-parsed-all.csv` when present for credit-card statement dates;
otherwise peeks PDF text (pdftotext).

From repo root:
  python3 server/scripts/organize-cfraser-statement-pdfs.py
  python3 server/scripts/organize-cfraser-statement-pdfs.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
CFRASER = REPO_ROOT / "cfraser"
LEGACY_CC_DIR = CFRASER / "pdfs"
CC_DIR = CFRASER / "credit-card-statements"
CART_DIR = CFRASER / "cartolas-cuenta-corriente"
CSV_PATH = CFRASER / "cc-statements-parsed-all.csv"
RE_ORGANIZED = re.compile(r"^\d{4}-\d{2}-\d{2} ", re.I)


def dd_to_iso(raw: str) -> str | None:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return f"{y:04d}-{mo:02d}-{d:02d}"


def peek_last4(text: str) -> str | None:
    m = re.search(r"XXXX\s+XXXX\s+XXXX\s+(\d{4})", text, re.I)
    return m.group(1) if m else None


def peek_meta(path: Path) -> tuple[str | None, bool, str | None]:
    try:
        text = subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return None, False, None
    upper = text.upper()
    intl = "ESTADO DE CUENTA INTERNACIONAL" in upper
    last4 = peek_last4(text)
    lines = [ln.strip() for ln in text.splitlines()]
    for i, ln in enumerate(lines):
        if "FECHA ESTADO" in ln.upper():
            for j in range(i + 1, min(i + 10, len(lines))):
                cand = lines[j].replace(" ", "")
                m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", cand)
                if m:
                    return dd_to_iso(m.group(0)), intl, last4
    for ln in lines:
        m = re.match(r"^(\d{2}/\d{2}/\d{4})$", ln)
        if m:
            iso = dd_to_iso(m.group(1))
            if iso:
                return iso, intl, last4
    return None, intl, last4


def load_csv_by_pdf() -> dict[str, dict[str, str]]:
    if not CSV_PATH.is_file():
        return {}
    out: dict[str, dict[str, str]] = {}
    with CSV_PATH.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pdf = str(row.get("source_pdf", "")).strip()
            if pdf and pdf not in out:
                out[pdf] = row
    return out


def cc_doc_type(row: dict[str, str] | None, intl: bool) -> str:
    if intl:
        return "estado de cuenta tarjeta usd"
    if row and (
        row.get("currency") == "usd" or row.get("parser_layout") == "international_usd"
    ):
        return "estado de cuenta tarjeta usd"
    return "estado de cuenta tarjeta"


def cc_suffix(name: str, row: dict[str, str] | None, peek_l4: str | None = None) -> str | None:
    if row:
        l4 = str(row.get("card_last4", "")).strip()
        if l4:
            return l4
    if peek_l4:
        return peek_l4
    if name.startswith("80_"):
        parts = name.replace(".pdf", "").split("_")
        if len(parts) >= 3:
            return parts[2][-4:]
    m = re.match(r"estado-de-cuenta-(\d+)\.pdf$", name, re.I)
    if m:
        return f"n{m.group(1)}"
    if name == "estado-de-cuenta-usd.pdf":
        return "usd"
    if name == "estado-de-cuenta.pdf":
        return "legacy"
    return None


def unique_dest(folder: Path, stem: str) -> Path:
    dest = folder / f"{stem}.pdf"
    if not dest.exists():
        return dest
    n = 2
    while True:
        cand = folder / f"{stem} ({n}).pdf"
        if not cand.exists():
            return cand
        n += 1


def organize_credit_card(dry_run: bool, by_pdf: dict[str, dict[str, str]]) -> int:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    sources = []
    if LEGACY_CC_DIR.is_dir():
        sources.extend(sorted(LEGACY_CC_DIR.glob("*.pdf")))
    for p in sorted(CC_DIR.glob("*.pdf")):
        if not RE_ORGANIZED.match(p.name):
            sources.append(p)
    moved = 0
    for p in sources:
        if RE_ORGANIZED.match(p.name) and p.parent.resolve() == CC_DIR.resolve():
            continue
        row = by_pdf.get(p.name)
        iso = dd_to_iso(row.get("statement_date", "")) if row else None
        peek_iso, peek_intl, peek_l4 = peek_meta(p)
        if peek_iso:
            iso = iso or peek_iso
        intl = peek_intl
        if not iso:
            print(f"skip (no date): {p}", file=sys.stderr)
            continue
        stem = f"{iso} {cc_doc_type(row, intl)}"
        suf = cc_suffix(p.name, row, peek_l4)
        if suf:
            stem += f" {suf}"
        dest = unique_dest(CC_DIR, stem)
        if dest.exists() and p.resolve() != dest.resolve():
            print(f"skip (already exists): {dest.relative_to(CFRASER)}")
            if not dry_run:
                p.unlink()
            moved += 1
            continue
        if p.resolve() == dest.resolve():
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
        moved += 1
    return moved


def organize_cartolas(dry_run: bool) -> int:
    CART_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    for p in sorted(CART_DIR.glob("*.pdf")):
        if RE_ORGANIZED.match(p.name):
            continue
        m = re.search(r"_(\d{2})(\d{2})(\d{4})(?:_CC)?\.pdf$", p.name, re.I)
        if not m:
            print(f"skip cartola: {p.name}", file=sys.stderr)
            continue
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        iso = f"{y:04d}-{mo:02d}-{d:02d}"
        tag = p.stem.split("_")[1] if "_" in p.stem else p.stem[:8]
        dest = unique_dest(CART_DIR, f"{iso} cartola cuenta corriente {tag}")
        if p.resolve() == dest.resolve():
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            shutil.move(str(p), str(dest))
        moved += 1
    return moved


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    by_pdf = load_csv_by_pdf()
    n_cc = organize_credit_card(args.dry_run, by_pdf)
    n_cart = organize_cartolas(args.dry_run)
    print(f"credit-card: {n_cc} file(s); cartolas: {n_cart} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
