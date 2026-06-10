#!/usr/bin/env python3
"""
Rename/move statement PDFs under cfraser/ to:

  credit-card-statements/<card-last4>/clp|usd/YYYY-MM-DD estado de cuenta tarjeta[ usd][ suffix].pdf
  cartolas-cuenta-corriente/YYYY-MM-DD cartola cuenta corriente [tag].pdf

Uses `cc-statements-parsed-all.csv` when present for credit-card statement dates;
otherwise peeks PDF text (pdftotext) after qpdf decrypt when needed
(`SANTANDER_CC_STATEMENT_PDF_PASSWORD`, `LIDER_CC_STATEMENT_PDF_PASSWORD`).
Ambiguous inbox files (unreadable PDF, missing date/card) are left in place and reported as errors (exit 1).
Confirmed duplicates (readable PDF, classified slot already on disk) are skipped without failing.

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
sys.path.insert(0, str(SCRIPT_DIR))

from cc_statement_pdf_paths import (
    UNREADABLE_DIR,
    cc_dest_path,
    clean_numbered_copy_filenames,
    is_organized_cc_pdf_name,
    pdf_already_in_card_slot,
    relocate_all_cc_pdfs_to_card_slots,
)

from cartola_pdf_kind import (
    incoming_vista_cartola_replaces_dest,
    is_checking_cartola_text,
    is_cuenta_vista_cartola_text,
    is_linea_credito_cartola_text,
    peek_cartola_hasta_and_no,
)
from cc_pdf_qpdf import (  # noqa: E402
    ensure_readable_for_parse,
    encrypted_password_env_hint,
    is_readable_bci_lider_statement_text,
    is_readable_cc_statement_text,
    is_readable_santander_cc_statement_text,
    load_repo_dotenv,
    peek_bci_lider_meta,
    peek_pdf_text,
    pdf_is_encrypted,
    qpdf_available,
)

CFRASER = REPO_ROOT / "cfraser"
INBOX_DIR = CFRASER / "inbox"
LEGACY_INBOX_DIR = CFRASER / "pdfs"


def resolve_inbox_dir() -> Path:
    if INBOX_DIR.is_dir():
        return INBOX_DIR
    return LEGACY_INBOX_DIR


CC_DIR = CFRASER / "credit-card-statements"
CART_DIR = CFRASER / "cartolas-cuenta-corriente"
VISTA_DIR = CFRASER / "cartolas-cuenta-vista"
LINEA_DIR = CFRASER / "cartolas-linea-credito"
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
# Santander email attachment: `1_<seq>_<account>_<date>_CC.pdf` = cuenta corriente cartola (not tarjeta).
SANTANDER_CHECKING_CARTOLA_ACCOUNT = "REDACTED"
RE_INBOX_CHECKING_CARTOLA = re.compile(
    rf"^1_(\d+)_{SANTANDER_CHECKING_CARTOLA_ACCOUNT}_(\d{{8}})(?:_CC)?\.pdf$",
    re.I,
)
RE_INBOX_VISTA_CM = re.compile(r"^1_(\d+)_(\d+)_(\d{8})_CM\.pdf$", re.I)
# Santander email attachment: `1_<seq>_REDACTED_<date>_LC.pdf` = línea de crédito cartola.
SANTANDER_LINEA_CREDITO_ACCOUNT = "REDACTED"
RE_INBOX_LINEA_CREDITO = re.compile(
    rf"^1_(\d+)_{SANTANDER_LINEA_CREDITO_ACCOUNT}_(\d{{8}})_LC\.pdf$",
    re.I,
)


def dd_to_iso(raw: str) -> str | None:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return f"{y:04d}-{mo:02d}-{d:02d}"


def iso_from_cartola_attachment_date(raw: str) -> str | None:
    """Parse 8-digit Santander inbox date (YYYYMMDD or DDMMYYYY)."""
    t = str(raw or "").strip()
    if len(t) != 8 or not t.isdigit():
        return None
    y4 = int(t[:4])
    if 1990 <= y4 <= 2039:
        mo, d = int(t[4:6]), int(t[6:8])
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return f"{y4:04d}-{mo:02d}-{d:02d}"
    d, mo, y = int(t[0:2]), int(t[2:4]), int(t[4:8])
    if 1 <= d <= 31 and 1 <= mo <= 12 and 1990 <= y <= 2039:
        return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def is_checking_cartola_inbox_name(name: str) -> bool:
    return bool(RE_INBOX_CHECKING_CARTOLA.match(name))


def is_cuenta_vista_inbox_name(name: str) -> bool:
    return bool(RE_INBOX_VISTA_CM.match(name))


def is_linea_credito_cartola_inbox_name(name: str) -> bool:
    return bool(RE_INBOX_LINEA_CREDITO.match(name))


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


def peek_last4(text: str) -> str | None:
    m = re.search(r"X{4}\s*X{4}\s*X{4}\s*(\d{4})", text, re.I)
    if m:
        return m.group(1)
    m2 = re.search(r"XXXXXXXXXXXX(\d{4})", text, re.I)
    return m2.group(1) if m2 else None


def ensure_cc_pdf_readable(path: Path, *, dry_run: bool) -> str | None:
    """Decrypt with qpdf when needed; return error message if text is still unreadable."""
    load_repo_dotenv()
    if dry_run:
        if is_readable_cc_statement_text(peek_pdf_text(path)):
            return None
        if pdf_is_encrypted(path):
            return (
                f"{path.name}: encrypted — {encrypted_password_env_hint()} and re-run "
                "(dry-run skips qpdf decrypt)"
            )
        return f"{path.name}: unreadable PDF (no credit-card statement text)"
    if not qpdf_available():
        if is_readable_cc_statement_text(peek_pdf_text(path)):
            return None
        return f"{path.name}: unreadable PDF and qpdf not installed (brew install qpdf)"
    note = ensure_readable_for_parse(path)
    if note and "repair failed" in note:
        return f"{path.name}: {note}"
    if not is_readable_cc_statement_text(peek_pdf_text(path)):
        detail = note or "still unreadable after qpdf"
        if pdf_is_encrypted(path):
            return f"{path.name}: encrypted — {encrypted_password_env_hint()} in .env and re-run"
        return f"{path.name}: {detail}"
    return None


def peek_meta(path: Path) -> tuple[str | None, bool, str | None]:
    text = peek_pdf_text(path)
    if is_readable_bci_lider_statement_text(text):
        iso, last4 = peek_bci_lider_meta(text)
        return iso, False, last4
    if not is_readable_santander_cc_statement_text(text):
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


def is_cuenta_vista_pdf(path: Path) -> bool:
    """CUENTAMATICA cartolas must not be filed under credit-card-statements."""
    hasta, _ = peek_cuenta_vista_meta(path)
    return hasta is not None


def organize_credit_card(dry_run: bool, by_pdf: dict[str, dict[str, str]]) -> tuple[int, list[str]]:
    CC_DIR.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    sources = []
    inbox = resolve_inbox_dir()
    if inbox.is_dir():
        sources.extend(sorted(inbox.glob("*.pdf")))
    for p in sorted(CC_DIR.rglob("*.pdf")):
        if UNREADABLE_DIR in p.parts:
            continue
        if pdf_already_in_card_slot(CC_DIR, p):
            continue
        if is_organized_cc_pdf_name(p.name):
            continue
        sources.append(p)
    moved = 0
    for p in sources:
        if RE_ORGANIZED.match(p.name) and p.parent.resolve() == CC_DIR.resolve():
            continue
        if is_cuenta_vista_pdf(p):
            continue
        if is_checking_cartola_inbox_name(p.name):
            continue
        if is_cuenta_vista_inbox_name(p.name):
            continue
        if is_linea_credito_cartola_inbox_name(p.name):
            continue
        try:
            peek_lc_text = peek_pdf_text(p)
        except OSError:
            peek_lc_text = ""
        if is_linea_credito_cartola_text(peek_lc_text):
            continue
        prep_err = ensure_cc_pdf_readable(p, dry_run=dry_run)
        if prep_err:
            errors.append(prep_err)
            continue
        row = by_pdf.get(p.name)
        fn_iso = iso_from_santander_80_filename(p.name)
        iso = dd_to_iso(row.get("statement_date", "")) if row else None
        if row and not iso:
            iso = dd_to_iso(row.get("period_to", ""))
        peek_iso, peek_intl, peek_l4 = peek_meta(p)
        if fn_iso:
            iso = fn_iso
        elif peek_iso:
            iso = iso or peek_iso
        intl = peek_intl
        if row and (row.get("currency") == "usd" or row.get("parser_layout") == "international_usd"):
            intl = True
        if row and str(row.get("parser_layout") or "").startswith("bci_lider"):
            intl = False
        if not iso:
            errors.append(f"{p.name}: no statement date (PDF text or CSV)")
            continue
        if fn_iso:
            print(
                f"date from filename: {p.name} -> {iso}",
                file=sys.stderr,
            )
        stem = f"{iso} {cc_doc_type(row, intl)}"
        suf = cc_suffix(p.name, row, peek_l4)
        if not suf:
            errors.append(f"{p.name}: no card last4 (PDF text or CSV)")
            continue
        if suf:
            stem += f" {suf}"
        dest = cc_dest_path(CC_DIR, suf, intl, stem)
        if dest.exists() and p.resolve() != dest.resolve():
            slot = "usd" if intl else "clp"
            print(
                f"skip (duplicate {slot}): {p.name} — "
                f"{dest.relative_to(CFRASER)} already exists",
                file=sys.stderr,
            )
            continue
        if p.resolve() == dest.resolve():
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
        moved += 1
    return moved, errors


def finalize_credit_card_layout(dry_run: bool) -> tuple[int, int]:
    cleaned = clean_numbered_copy_filenames(CC_DIR, dry_run=dry_run)
    relocated = relocate_all_cc_pdfs_to_card_slots(CC_DIR, dry_run=dry_run)
    return cleaned, relocated


def cartola_no_suffix(cartola_no: str | None) -> str:
    """Santander often emits cartola number 0; omit useless suffixes from filenames."""
    no = str(cartola_no or "").strip()
    if not no or no == "0":
        return ""
    return f" {no}"


def peek_cuenta_vista_meta(path: Path) -> tuple[str | None, str | None]:
    try:
        text = subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return None, None
    if not is_cuenta_vista_cartola_text(text):
        return None, None
    hasta, cartola_no = peek_cartola_hasta_and_no(text)
    if not hasta:
        m = RE_INBOX_VISTA_CM.match(path.name)
        if m:
            hasta = iso_from_cartola_attachment_date(m.group(3))
    return hasta, cartola_no


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


def organize_cuenta_vista(dry_run: bool) -> int:
    VISTA_DIR.mkdir(parents=True, exist_ok=True)
    sources: list[Path] = []
    inbox = resolve_inbox_dir()
    if inbox.is_dir():
        sources.extend(sorted(inbox.glob("*.pdf")))
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
        stem = f"{hasta} cartola cuenta vista{cartola_no_suffix(cartola_no)}"
        canonical = VISTA_DIR / f"{stem}.pdf"
        if canonical.exists() and p.resolve() != canonical.resolve():
            if incoming_vista_cartola_replaces_dest(canonical, p):
                print(
                    f"replace sin-movimientos cartola: {canonical.name} "
                    f"<- {p.name}"
                )
                if not dry_run:
                    canonical.unlink()
                    shutil.move(str(p), str(canonical))
                moved += 1
                continue
            print(f"skip (already exists): {canonical.relative_to(CFRASER)}")
            if not dry_run:
                p.unlink()
            moved += 1
            continue
        dest = unique_dest(VISTA_DIR, stem)
        if p.resolve() == dest.resolve():
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
        moved += 1
    return moved


def relocate_misfiled_checking_from_vista(dry_run: bool) -> int:
    """Move cuenta corriente cartolas wrongly filed under cartolas-cuenta-vista/."""
    CART_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    for p in sorted(VISTA_DIR.glob("*.pdf")):
        try:
            text = subprocess.check_output(
                ["pdftotext", str(p), "-"],
                text=True,
                stderr=subprocess.DEVNULL,
            )
        except (FileNotFoundError, subprocess.CalledProcessError, OSError):
            continue
        if not is_checking_cartola_text(text):
            continue
        hasta, cartola_no = peek_cartola_hasta_and_no(text)
        if not hasta:
            print(f"skip misfiled checking (no period): {p.name}", file=sys.stderr)
            continue
        stem = f"{hasta} cartola cuenta corriente{cartola_no_suffix(cartola_no)}"
        dest = unique_dest(CART_DIR, stem)
        if dest.exists() and p.resolve() != dest.resolve():
            print(f"skip (checking already exists): {dest.relative_to(CFRASER)}")
            if not dry_run:
                p.unlink()
            moved += 1
            continue
        if p.resolve() == dest.resolve():
            continue
        print(f"misfiled checking: {p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            shutil.move(str(p), str(dest))
        moved += 1
    return moved


def organize_linea_credito_cartolas_inbox(dry_run: bool) -> int:
    """File Santander `1_*_REDACTED_*_LC.pdf` inbox downloads as línea de crédito cartolas."""
    LINEA_DIR.mkdir(parents=True, exist_ok=True)
    inbox = resolve_inbox_dir()
    if not inbox.is_dir():
        return 0
    moved = 0
    for p in sorted(inbox.glob("*.pdf")):
        m = RE_INBOX_LINEA_CREDITO.match(p.name)
        if not m:
            continue
        tag, raw_date = m.group(1), m.group(2)
        hasta: str | None = None
        cartola_no: str | None = None
        try:
            text = subprocess.check_output(
                ["pdftotext", str(p), "-"],
                text=True,
                stderr=subprocess.DEVNULL,
            )
            hasta, cartola_no = peek_cartola_hasta_and_no(text)
        except (FileNotFoundError, subprocess.CalledProcessError, OSError):
            pass
        if not hasta:
            hasta = iso_from_cartola_attachment_date(raw_date)
        if not hasta:
            print(f"skip linea credito cartola (bad date): {p.name}", file=sys.stderr)
            continue
        stem = f"{hasta} cartola linea credito{cartola_no_suffix(cartola_no)}"
        if not cartola_no_suffix(cartola_no):
            stem += f" {tag}"
        dest = unique_dest(LINEA_DIR, stem)
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
            shutil.move(str(p), str(dest))
        moved += 1
    return moved


def organize_checking_cartolas_inbox(dry_run: bool) -> int:
    """File Santander `1_*_REDACTED_*_CC.pdf` inbox downloads as checking cartolas."""
    CART_DIR.mkdir(parents=True, exist_ok=True)
    inbox = resolve_inbox_dir()
    if not inbox.is_dir():
        return 0
    moved = 0
    for p in sorted(inbox.glob("*.pdf")):
        m = RE_INBOX_CHECKING_CARTOLA.match(p.name)
        if not m:
            continue
        tag, raw_date = m.group(1), m.group(2)
        hasta: str | None = None
        cartola_no: str | None = None
        try:
            text = subprocess.check_output(
                ["pdftotext", str(p), "-"],
                text=True,
                stderr=subprocess.DEVNULL,
            )
            if is_checking_cartola_text(text):
                hasta, cartola_no = peek_cartola_hasta_and_no(text)
        except (FileNotFoundError, subprocess.CalledProcessError, OSError):
            pass
        if not hasta:
            hasta = iso_from_cartola_attachment_date(raw_date)
        if not hasta:
            print(f"skip checking cartola (bad date): {p.name}", file=sys.stderr)
            continue
        stem = f"{hasta} cartola cuenta corriente{cartola_no_suffix(cartola_no)}"
        if not cartola_no_suffix(cartola_no):
            stem += f" {tag}"
        dest = unique_dest(CART_DIR, stem)
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
    load_repo_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    by_pdf = load_csv_by_pdf()
    # Vista PDFs in cfraser/inbox/ must be filed before credit-card organize reads the same inbox.
    n_vista = organize_cuenta_vista(args.dry_run)
    n_reloc_vista = relocate_misfiled_checking_from_vista(args.dry_run)
    n_linea_inbox = organize_linea_credito_cartolas_inbox(args.dry_run)
    n_check_inbox = organize_checking_cartolas_inbox(args.dry_run)
    n_cc, cc_errors = organize_credit_card(args.dry_run, by_pdf)
    n_clean, n_reloc = finalize_credit_card_layout(args.dry_run)
    n_cart = organize_cartolas(args.dry_run)
    print(
        f"cuenta-vista: {n_vista} file(s); vista→checking relocate: {n_reloc_vista} file(s); "
        f"linea-credito-inbox: {n_linea_inbox} file(s); checking-inbox: {n_check_inbox} file(s); "
        f"credit-card: {n_cc} file(s); "
        f"cc-clean (n): {n_clean}; cc-relocate: {n_reloc}; cartolas: {n_cart} file(s)"
    )
    if cc_errors:
        for err in cc_errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
