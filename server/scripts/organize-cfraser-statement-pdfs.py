#!/usr/bin/env python3
"""
Rename/move statement PDFs under cfraser/ to:

  credit-card-statements/YYYY-MM-DD estado de cuenta tarjeta[ usd][ suffix].pdf
  cartolas-cuenta-corriente/YYYY-MM-DD cartola cuenta corriente [tag].pdf

Uses `cc-statements-parsed-all.csv` when present for credit-card statement dates;
otherwise peeks PDF text (pdftotext).

From repo root:
  npm run import:cfraser-inbox          # organize + parse + import (recommended)
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
VISTA_DIR = CFRASER / "cartolas-cuenta-vista"
CSV_PATH = CFRASER / "cc-statements-parsed-all.csv"
RE_ORGANIZED = re.compile(r"^\d{4}-\d{2}-\d{2} ", re.I)
# Santander email/download name: 80_<seq>_<account>_YYYYMMDD.pdf
RE_SANTANDER_80_DATE = re.compile(r"^80_\d+_\d+_(\d{8})\.pdf$", re.I)
# Older Santander download: 157_<seq>_<account>_YYYYMMDD.pdf (image/legacy layout)
RE_SANTANDER_157_DATE = re.compile(r"^157_\d+_\d+_(\d{8})\.pdf$", re.I)
# Full account id in 80_* downloads → card last-4 (not the last 4 digits of the account string).
SANTANDER_80_ACCOUNT_TO_CARD_LAST4: dict[str, str] = {
    "REDACTED": "4141",
    "REDACTED": "4141",
}


def dd_to_iso(raw: str) -> str | None:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return f"{y:04d}-{mo:02d}-{d:02d}"


def iso_from_santander_80_filename(name: str) -> str | None:
    """Statement close date embedded in Santander `80_*_YYYYMMDD.pdf` downloads."""
    m = RE_SANTANDER_80_DATE.match(name)
    if not m:
        m = RE_SANTANDER_157_DATE.match(name)
    if not m:
        return None
    raw = m.group(1)
    y, mo, d = int(raw[0:4]), int(raw[4:6]), int(raw[6:8])
    if mo < 1 or mo > 12 or d < 1 or d > 31:
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def _santander_download_account_id(name: str) -> str | None:
    if name.startswith("80_") or name.startswith("157_"):
        parts = name.replace(".pdf", "").split("_")
        if len(parts) >= 3:
            return parts[2]
    return None


def build_santander_80_iso_groups(
    sources: list[Path], cc_dir: Path | None = None
) -> dict[str, list[Path]]:
    """Group inbox `80_*` PDFs by close date; include same-date files already in `cc_dir` for CLP/USD pairing."""
    groups: dict[str, list[Path]] = {}
    for p in sources:
        iso = iso_from_santander_80_filename(p.name)
        if iso:
            groups.setdefault(iso, []).append(p)
    if cc_dir is not None and cc_dir.is_dir():
        for iso in list(groups):
            for existing in cc_dir.glob(f"{iso} estado de cuenta tarjeta*.pdf"):
                if existing.resolve() not in {q.resolve() for q in groups[iso]}:
                    groups[iso].append(existing)
    return groups


def build_intl_flags_for_santander_80_pairs(
    groups: dict[str, list[Path]],
) -> dict[Path, bool]:
    """
    Legacy/image PDFs often have no extractable FECHA ESTADO text.
    For a same-date CLP+USD pair, the smaller file is typically the USD statement.
    """
    out: dict[Path, bool] = {}
    for peers in groups.values():
        if len(peers) != 2:
            continue
        ordered = sorted(peers, key=lambda p: p.stat().st_size)
        out[ordered[0].resolve()] = True
        out[ordered[1].resolve()] = False
    return out


def peek_last4(text: str) -> str | None:
    m = re.search(r"X{4}\s*X{4}\s*X{4}\s*(\d{4})", text, re.I)
    if m:
        return m.group(1)
    m2 = re.search(r"XXXXXXXXXXXX(\d{4})", text, re.I)
    return m2.group(1) if m2 else None


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
    if name.startswith("80_") or name.startswith("157_"):
        acct = _santander_download_account_id(name)
        if acct and acct in SANTANDER_80_ACCOUNT_TO_CARD_LAST4:
            return SANTANDER_80_ACCOUNT_TO_CARD_LAST4[acct]
        if acct:
            return acct[-4:]
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


def is_cuenta_vista_pdf(path: Path) -> bool:
    """CUENTAMATICA cartolas must not be filed under credit-card-statements."""
    hasta, _ = peek_cuenta_vista_meta(path)
    return hasta is not None


def organize_credit_card(dry_run: bool, by_pdf: dict[str, dict[str, str]]) -> int:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    sources = []
    if LEGACY_CC_DIR.is_dir():
        sources.extend(sorted(LEGACY_CC_DIR.glob("*.pdf")))
    for p in sorted(CC_DIR.glob("*.pdf")):
        if not RE_ORGANIZED.match(p.name):
            sources.append(p)
    iso_groups_80 = build_santander_80_iso_groups(sources, CC_DIR)
    intl_by_path_80 = build_intl_flags_for_santander_80_pairs(iso_groups_80)
    moved = 0
    for p in sources:
        if RE_ORGANIZED.match(p.name) and p.parent.resolve() == CC_DIR.resolve():
            continue
        if is_cuenta_vista_pdf(p):
            continue
        row = by_pdf.get(p.name)
        fn_iso = iso_from_santander_80_filename(p.name)
        iso = dd_to_iso(row.get("statement_date", "")) if row else None
        peek_iso, peek_intl, peek_l4 = peek_meta(p)
        if fn_iso:
            iso = fn_iso
        elif peek_iso:
            iso = iso or peek_iso
        intl = peek_intl or intl_by_path_80.get(p.resolve(), False)
        if not iso:
            print(f"skip (no date): {p}", file=sys.stderr)
            continue
        if fn_iso:
            print(
                f"date from filename: {p.name} -> {iso}",
                file=sys.stderr,
            )
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


def peek_cuenta_vista_meta(path: Path) -> tuple[str | None, str | None]:
    try:
        text = subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return None, None
    upper = text.upper()
    if "CUENTAMATICA" not in upper and "ESTADO CUENTAMATICA" not in upper:
        return None, None
    m = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})", text)
    if not m:
        return None, None
    hasta = dd_to_iso(m.group(2))
    cartola_no = None
    cm = re.search(r"CARTOLA\s+(\d+)", text, re.I)
    if cm:
        cartola_no = cm.group(1)
    return hasta, cartola_no


def organize_cuenta_vista(dry_run: bool) -> int:
    VISTA_DIR.mkdir(parents=True, exist_ok=True)
    sources: list[Path] = []
    if LEGACY_CC_DIR.is_dir():
        sources.extend(sorted(LEGACY_CC_DIR.glob("*.pdf")))
    for p in sorted(VISTA_DIR.glob("*.pdf")):
        if not RE_ORGANIZED.match(p.name):
            sources.append(p)
    moved = 0
    seen: set[Path] = set()
    for p in sources:
        if p.resolve() in seen:
            continue
        seen.add(p.resolve())
        if RE_ORGANIZED.match(p.name) and p.parent.resolve() == VISTA_DIR.resolve():
            continue
        hasta, cartola_no = peek_cuenta_vista_meta(p)
        if not hasta:
            continue
        stem = f"{hasta} cartola cuenta vista"
        if cartola_no:
            stem += f" {cartola_no}"
        dest = unique_dest(VISTA_DIR, stem)
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
    # Vista PDFs in cfraser/pdfs/ must be filed before credit-card organize reads the same inbox.
    n_vista = organize_cuenta_vista(args.dry_run)
    n_cc = organize_credit_card(args.dry_run, by_pdf)
    n_cart = organize_cartolas(args.dry_run)
    print(f"cuenta-vista: {n_vista} file(s); credit-card: {n_cc} file(s); cartolas: {n_cart} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
