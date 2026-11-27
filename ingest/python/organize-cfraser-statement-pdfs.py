#!/usr/bin/env python3
"""
Rename/move statement PDFs under cfraser/ to:

  credit-card-statements/<card-last4>/clp|usd/YYYY-MM-DD estado de cuenta tarjeta[ usd][ suffix].pdf
  cartolas-cuenta-corriente/YYYY-MM-DD cartola cuenta corriente [tag].pdf
  cartolas-cuenta-vista/YYYY-MM-DD cartola cuenta vista.pdf
  cartolas-linea-credito/YYYY-MM-DD cartola linea credito [n].pdf
  cartolas-otras-cuentas/YYYY-MM-DD cartola <product> <account tail> [n].pdf   (never imported)

Santander's mailed attachment names carry neither account nor date since October 2026
(`TC_NAC-<n>_<m>.pdf`, `LCA_CTA_CTE_CRONO-<n>_<m>.pdf`, …): encrypted inbox PDFs are decrypted
in place first, then each is classified from its text — a cartola by its product heading and the
account printed in its header, everything else as a card statement.

Uses `cc-statements-parsed-all.csv` when present for credit-card statement dates;
otherwise peeks PDF text (pdftotext) after qpdf decrypt when needed
(`SANTANDER_CC_STATEMENT_PDF_PASSWORD`, `LIDER_CC_STATEMENT_PDF_PASSWORD`).
Ambiguous inbox files (unreadable PDF, missing date/card) are left in place and reported as errors (exit 1).
Confirmed duplicates (readable PDF, classified slot already on disk) move to
`cfraser/inbox/duplicates/` (ignored on later runs) without failing.

From repo root:
  npm run import:cfraser-inbox          # organize + parse + import (recommended)
  python3 ingest/python/organize-cfraser-statement-pdfs.py
  python3 ingest/python/organize-cfraser-statement-pdfs.py --dry-run
  python3 ingest/python/organize-cfraser-statement-pdfs.py --manifest=cfraser/inbox-organize-manifest.json
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from cc_statement_pdf_paths import (
    UNREADABLE_DIR,
    cc_dest_path,
    clean_numbered_copy_filenames,
    is_excluded_cc_pdf_path,
    is_organized_cc_pdf_name,
    pdf_already_in_card_slot,
    relocate_all_cc_pdfs_to_card_slots,
)

from cartola_pdf_kind import (
    CARTOLA_PRODUCT_CHECKING,
    CARTOLA_PRODUCT_CHECKING_FOREIGN,
    CARTOLA_PRODUCT_CUENTA_VISTA,
    CARTOLA_PRODUCT_LINEA_CREDITO,
    account_digits,
    cartola_product,
    incoming_vista_cartola_replaces_dest,
    peek_cartola_account,
    peek_cartola_header,
    peek_cartola_pdf_account,
    is_checking_cartola_text,
    is_cuenta_vista_cartola_text,
    is_linea_credito_cartola_text,
    peek_cartola_hasta_and_no,
)
from statement_values import parse_dd_mm_yy_to_iso  # noqa: E402
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
    statement_pdf_passwords_to_try,
    try_qpdf_decrypt_with_password,
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
# Cartolas for bank accounts this tracker does not model. They are filed out of the way rather
# than dropped, so the inbox stays clear and the documents are still on disk, but no importer
# ever scans this directory.
OTHER_ACCOUNTS_DIR = CFRASER / "cartolas-otras-cuentas"
CSV_PATH = CFRASER / "cc-statements-parsed-all.csv"

_INBOX_MANIFEST: dict[str, list[str]] = {
    "cuenta_vista_pdfs": [],
    "checking_pdfs": [],
    "credit_card_pdfs": [],
}


def reset_inbox_manifest() -> None:
    for bucket in _INBOX_MANIFEST.values():
        bucket.clear()


def record_inbox_filed(category: str, dest: Path, source: Path) -> None:
    inbox = resolve_inbox_dir()
    if not inbox.is_dir() or source.parent.resolve() != inbox.resolve():
        return
    bucket = _INBOX_MANIFEST.get(category)
    if bucket is None:
        return
    rel = str(dest.relative_to(CFRASER))
    if rel not in bucket:
        bucket.append(rel)


def write_inbox_manifest(path: Path | None) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_INBOX_MANIFEST, indent=2) + "\n", encoding="utf-8")
    print(f"inbox manifest: {path.relative_to(REPO_ROOT)}")
RE_ORGANIZED = re.compile(r"^\d{4}-\d{2}-\d{2} ", re.I)
# Santander email/download name: 80_<seq>_<account>_YYYYMMDD.pdf
RE_SANTANDER_80_DATE = re.compile(r"^80_\d+_\d+_(\d{8})\.pdf$", re.I)
# Older Santander download: 157_<seq>_<account>_YYYYMMDD.pdf (image/legacy layout)
RE_SANTANDER_157_DATE = re.compile(r"^157_\d+_\d+_(\d{8})\.pdf$", re.I)
# Personal Santander identifiers (contract/account numbers) live OUTSIDE git in
# cfraser/organize-identifiers.json (cfraser/ is gitignored). Shape:
#   {
#     "santander_80_account_to_card_last4": {"<80_* account id>": "<card last4>", ...},
#     "santander_checking_cartola_account": "<cuenta corriente account id>",
#     "santander_linea_credito_account": "<línea de crédito account id>",
#     "santander_ignored_cartola_accounts": ["0-000-00-00000-0", ...],  // optional
#     "santander_cuenta_vista_account": "<cuenta vista account id>"       // optional
#   }
# Account ids are compared by their digits, so `0-000-00-00001-1` (as a cartola prints it) and
# `000000000011` name the same account.
# Tests point NW_TRACKER_ORGANIZE_IDENTIFIERS at a synthetic copy.
ORGANIZE_IDENTIFIERS_PATH = Path(
    os.environ.get("NW_TRACKER_ORGANIZE_IDENTIFIERS", str(CFRASER / "organize-identifiers.json"))
)


def _load_organize_identifiers() -> dict:
    if not ORGANIZE_IDENTIFIERS_PATH.is_file():
        raise SystemExit(
            f"missing {ORGANIZE_IDENTIFIERS_PATH}: personal Santander identifiers are kept out of git — "
            "create the JSON (shape documented above ORGANIZE_IDENTIFIERS_PATH in this script) "
            "or restore it from the backups folder"
        )
    data = json.loads(ORGANIZE_IDENTIFIERS_PATH.read_text(encoding="utf-8"))
    missing = [
        k
        for k in (
            "santander_80_account_to_card_last4",
            "santander_checking_cartola_account",
            "santander_linea_credito_account",
        )
        if k not in data
    ]
    if missing:
        raise SystemExit(f"{ORGANIZE_IDENTIFIERS_PATH}: missing keys: {', '.join(missing)}")
    return data


_ORGANIZE_IDENTIFIERS = _load_organize_identifiers()
# Full account id in 80_* downloads → card last-4 (not the last 4 digits of the account string).
SANTANDER_80_ACCOUNT_TO_CARD_LAST4: dict[str, str] = _ORGANIZE_IDENTIFIERS[
    "santander_80_account_to_card_last4"
]
# Santander email attachment: `1_<seq>_<account>_<date>_CC.pdf` = cuenta corriente cartola (not tarjeta).
SANTANDER_CHECKING_CARTOLA_ACCOUNT: str = _ORGANIZE_IDENTIFIERS["santander_checking_cartola_account"]
RE_INBOX_CHECKING_CARTOLA = re.compile(
    rf"^1_(\d+)_{SANTANDER_CHECKING_CARTOLA_ACCOUNT}_(\d{{8}})(?:_CC)?\.pdf$",
    re.I,
)
RE_INBOX_VISTA_CM = re.compile(r"^1_(\d+)_(\d+)_(\d{8})_CM\.pdf$", re.I)
# Santander email attachment: `1_<seq>_<lc account>_<date>_LC.pdf` = línea de crédito cartola.
SANTANDER_LINEA_CREDITO_ACCOUNT: str = _ORGANIZE_IDENTIFIERS["santander_linea_credito_account"]
# Optional: printed account numbers (`0-000-00-00002-2` form) whose cartolas must NOT be imported.
# Santander keeps mailing a monthly cartola for a dormant account forever, and the cuenta vista
# importer would file those under the tracked account — a second cuenta vista shared the tracked
# one's filename space for years this way. Absent key = ignore nothing.
IGNORED_CARTOLA_ACCOUNTS: set[str] = {
    str(a).strip()
    for a in _ORGANIZE_IDENTIFIERS.get("santander_ignored_cartola_accounts", [])
    if str(a).strip()
}
def is_ignored_cartola_account(account: str | None) -> bool:
    """Ignored accounts compare by digits, like every other configured account id."""
    digits = account_digits(account)
    return bool(digits) and digits in {account_digits(a) for a in IGNORED_CARTOLA_ACCOUNTS}


def masked_account(account: str | None) -> str:
    """`·1234`: the last four digits, enough to recognise an account in a run log."""
    digits = account_digits(account)
    return f"·{digits[-4:]}" if digits else "(no account printed)"


# Errors of passes that report through the module (the vista pass returns a count); main() reads them.
_RUN_ERRORS: list[str] = []


# Optional: the tracked cuenta vista. Absent = every cuenta vista cartola not ignored above is the
# tracked one. Set = an inbox vista cartola of any other non-ignored account fails the run.
SANTANDER_CUENTA_VISTA_ACCOUNT: str = account_digits(
    _ORGANIZE_IDENTIFIERS.get("santander_cuenta_vista_account", "")
)
RE_INBOX_LINEA_CREDITO = re.compile(
    rf"^1_(\d+)_{SANTANDER_LINEA_CREDITO_ACCOUNT}_(\d{{8}})_LC\.pdf$",
    re.I,
)
RE_INBOX_SPANISH_MONTH_PDF = re.compile(
    r"^([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+(\d{4})(?:-\d+)?\.pdf$",
    re.I,
)
SPANISH_MONTH_TO_NUM: dict[str, int] = {
    "enero": 1,
    "febrero": 2,
    "marzo": 3,
    "abril": 4,
    "mayo": 5,
    "junio": 6,
    "julio": 7,
    "agosto": 8,
    "septiembre": 9,
    "octubre": 10,
    "noviembre": 11,
    "diciembre": 12,
}


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


# Inbox PDFs an earlier pass of this run has classified (filed, parked, or refused with an error).
# Later passes skip them: on a dry run nothing moves, and a cartola's text also passes the loose
# credit-card readability check, so the card pass would otherwise claim it a second time.
_CLAIMED_THIS_RUN: set[Path] = set()


def claim(path: Path) -> None:
    _CLAIMED_THIS_RUN.add(path.resolve())


def is_claimed(path: Path) -> bool:
    return path.resolve() in _CLAIMED_THIS_RUN


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


def iso_from_spanish_month_pdf_name(name: str) -> str | None:
    """Inbox scans named ``MAYO 2017.pdf`` → last calendar day of that month (organize fallback)."""
    m = RE_INBOX_SPANISH_MONTH_PDF.match(name)
    if not m:
        return None
    month_name = (
        m.group(1)
        .lower()
        .strip()
        .translate(str.maketrans("áéíóúñ", "aeioun"))
    )
    mo = SPANISH_MONTH_TO_NUM.get(month_name)
    y = int(m.group(2))
    if not mo or not (1990 <= y <= 2039):
        return None
    if mo == 12:
        next_y, next_mo = y + 1, 1
    else:
        next_y, next_mo = y, mo + 1
    last_day = (date(next_y, next_mo, 1) - timedelta(days=1)).day
    return f"{y:04d}-{mo:02d}-{last_day:02d}"


def peek_meta(path: Path) -> tuple[str | None, bool, str | None]:
    text = peek_pdf_text(path)
    if is_readable_bci_lider_statement_text(text):
        iso, last4 = peek_bci_lider_meta(text)
        return iso, False, last4
    if not is_readable_santander_cc_statement_text(text):
        return None, False, None
    upper = text.upper()
    intl = "ESTADO DE CUENTA INTERNACIONAL" in upper or (
        "INTERNACIONAL" in upper and "MONTO US$" in upper
    )
    last4 = peek_last4(text)
    m_period = re.search(
        r"PER[IÍ]ODO\s+FACTURADO[^\d]*(\d{2}/\d{2}/\d{4})[^\d]*(\d{2}/\d{2}/\d{4})",
        text,
        re.I,
    )
    if m_period:
        iso = parse_dd_mm_yy_to_iso(m_period.group(2))
        if iso:
            return iso, intl, last4
    m_stmt = re.search(
        r"FECHA\s+ESTADO\s+DE\s+CUENTA[^\d]*(\d{2}/\d{2}/\d{4})",
        text,
        re.I,
    )
    if m_stmt:
        iso = parse_dd_mm_yy_to_iso(m_stmt.group(1))
        if iso:
            return iso, intl, last4
    m_pay = re.search(r"PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})", text, re.I)
    if m_pay:
        iso = parse_dd_mm_yy_to_iso(m_pay.group(1))
        if iso:
            return iso, intl, last4
    lines = [ln.strip() for ln in text.splitlines()]
    for i, ln in enumerate(lines):
        if "FECHA ESTADO" in ln.upper():
            for j in range(i + 1, min(i + 10, len(lines))):
                cand = lines[j].replace(" ", "")
                m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", cand)
                if m:
                    return parse_dd_mm_yy_to_iso(m.group(0)), intl, last4
    for ln in lines:
        m = re.match(r"^(\d{2}/\d{2}/\d{4})$", ln)
        if m:
            iso = parse_dd_mm_yy_to_iso(m.group(1))
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
        # Quarantined folders are not re-filed: organizing a pending-review statement back into
        # its card slot would undo the quarantine and the nightly import would fail again.
        if is_excluded_cc_pdf_path(p):
            continue
        if pdf_already_in_card_slot(CC_DIR, p):
            continue
        if is_organized_cc_pdf_name(p.name):
            continue
        sources.append(p)
    moved = 0
    for p in sources:
        if is_claimed(p):
            continue
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
        iso = parse_dd_mm_yy_to_iso(row.get("statement_date", "")) if row else None
        if row and not iso:
            iso = parse_dd_mm_yy_to_iso(row.get("period_to", ""))
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
            iso = iso_from_spanish_month_pdf_name(p.name)
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
        if not suf and RE_INBOX_SPANISH_MONTH_PDF.match(p.name) and peek_l4:
            suf = peek_l4
        if not suf:
            errors.append(f"{p.name}: no card last4 (PDF text or CSV)")
            continue
        if suf:
            stem += f" {suf}"
        dest = cc_dest_path(CC_DIR, suf, intl, stem)
        if dest.exists() and p.resolve() != dest.resolve():
            slot = "usd" if intl else "clp"
            move_inbox_duplicate(
                p,
                dry_run=dry_run,
                reason=f"{dest.relative_to(CFRASER)} already exists ({slot})",
            )
            continue
        if p.resolve() == dest.resolve():
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
        record_inbox_filed("credit_card_pdfs", dest, p)
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
        # `-layout` for the same reason as the checking cartola peek: the DESDE/HASTA header is a
        # column table and collapses into neighbouring values without it.
        text = subprocess.check_output(
            ["pdftotext", "-layout", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return None, None
    if not is_cuenta_vista_cartola_text(text):
        return None, None
    hasta, cartola_no = peek_cartola_hasta_and_no(text)
    header = peek_cartola_header(text)
    if header:
        # The printed HASTA. The cartola number keeps coming from the older peek, which leaves
        # it out of the name the way the filed corpus is named.
        return header[2], cartola_no
    m = RE_INBOX_VISTA_CM.match(path.name)
    if not m and path.parent.resolve() == resolve_inbox_dir().resolve():
        # A bank-named attachment without a readable header is not named by guesswork
        # (the card pass then refuses it loudly).
        return None, None
    if not hasta and m:
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


def move_inbox_duplicate(p: Path, *, dry_run: bool, reason: str = "") -> Path:
    """Archive an inbox PDF whose canonical copy already exists (ignored on future runs)."""
    inbox = resolve_inbox_dir()
    if p.parent.resolve() != inbox.resolve():
        return p
    dup_dir = inbox / "duplicates"
    dest = unique_dest(dup_dir, p.stem)
    rel = dest.relative_to(CFRASER)
    detail = f" — {reason}" if reason else ""
    print(f"inbox duplicate -> {rel}{detail}", file=sys.stderr)
    if not dry_run:
        dup_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), str(dest))
    return dest


def file_ignored_account_cartola(
    p: Path, hasta: str, account: str, *, dry_run: bool
) -> int:
    """Park a cartola belonging to an untracked bank account outside every importer's scan."""
    tail = account.rsplit("-", 2)[1] if "-" in account else account
    stem = f"{hasta} cartola cuenta {tail}"
    canonical = OTHER_ACCOUNTS_DIR / f"{stem}.pdf"
    if canonical.exists() and p.parent.resolve() == resolve_inbox_dir().resolve():
        # The same account and period mailed again (one account, one cartola per period).
        move_inbox_duplicate(p, dry_run=dry_run, reason=f"{canonical.relative_to(CFRASER)} already exists")
        return 1
    dest = unique_dest(OTHER_ACCOUNTS_DIR, stem)
    if p.resolve() == dest.resolve():
        return 0
    print(f"{p.name} -> {dest.relative_to(CFRASER)} (untracked account {account})")
    if not dry_run:
        OTHER_ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), str(dest))
    return 1


def relocate_ignored_account_cartolas(dry_run: bool) -> int:
    """
    Evict already-filed cartolas belonging to an untracked account.

    The main loop only reconsiders files whose names are not yet canonical, so without this pass
    an ignored account's cartolas would keep sitting in the tracked account's corpus (and keep
    being importable) purely because they were filed before the account was ignored.
    """
    if not IGNORED_CARTOLA_ACCOUNTS or not VISTA_DIR.is_dir():
        return 0
    moved = 0
    for p in sorted(VISTA_DIR.glob("*.pdf")):
        account = peek_cartola_pdf_account(p)
        if not account or not is_ignored_cartola_account(account):
            continue
        hasta, _no = peek_cuenta_vista_meta(p)
        moved += file_ignored_account_cartola(p, hasta or p.stem[:10], account, dry_run=dry_run)
    return moved


def organize_cuenta_vista(dry_run: bool) -> int:
    VISTA_DIR.mkdir(parents=True, exist_ok=True)
    relocate_ignored_account_cartolas(dry_run)
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
        claim(p)
        if IGNORED_CARTOLA_ACCOUNTS or SANTANDER_CUENTA_VISTA_ACCOUNT:
            pdf_account = peek_cartola_pdf_account(p)
            if pdf_account and is_ignored_cartola_account(pdf_account):
                moved += file_ignored_account_cartola(p, hasta, pdf_account, dry_run=dry_run)
                continue
            if (
                SANTANDER_CUENTA_VISTA_ACCOUNT
                and p.parent.resolve() == inbox.resolve()
                and account_digits(pdf_account) != SANTANDER_CUENTA_VISTA_ACCOUNT
            ):
                # Left in the inbox: an unknown account is a configuration question, not a guess.
                _RUN_ERRORS.append(
                    f"{p.name}: cuenta vista cartola of account {masked_account(pdf_account)}, which is neither "
                    "santander_cuenta_vista_account nor in santander_ignored_cartola_accounts — fix "
                    "organize-identifiers.json or add the account to santander_ignored_cartola_accounts"
                )
                continue
        stem = f"{hasta} cartola cuenta vista{cartola_no_suffix(cartola_no)}"
        canonical = VISTA_DIR / f"{stem}.pdf"
        # Two cuenta vista accounts mail a cartola for the same period, and Santander leaves the
        # cartola number blank on both — so period alone does not name a document, and the second
        # to arrive used to be archived as a "duplicate" of the first. When the occupant belongs to
        # a different account, the incoming one gets its own name instead of being displaced.
        if canonical.exists() and p.resolve() != canonical.resolve():
            incoming_account = peek_cartola_pdf_account(p)
            occupant_account = peek_cartola_pdf_account(canonical)
            if incoming_account and occupant_account and incoming_account != occupant_account:
                stem = f"{stem} cuenta {incoming_account.rsplit('-', 2)[1]}"
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
                record_inbox_filed("cuenta_vista_pdfs", canonical, p)
                moved += 1
                continue
            reason = f"{canonical.relative_to(CFRASER)} already exists"
            if p.parent.resolve() == inbox.resolve():
                move_inbox_duplicate(p, dry_run=dry_run, reason=reason)
            else:
                print(f"skip (already exists): {reason}")
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
        record_inbox_filed("cuenta_vista_pdfs", dest, p)
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
    """File Santander `1_*_<lc account>_*_LC.pdf` inbox downloads as línea de crédito cartolas."""
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
            move_inbox_duplicate(
                p,
                dry_run=dry_run,
                reason=f"{dest.relative_to(CFRASER)} already exists",
            )
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
            # `-layout` is required, not cosmetic: the DESDE/HASTA header is a column table, and
            # without it the columns interleave so the header regex misses and the last-resort
            # "last date in the document" fallback picks up the línea de crédito's FECHA
            # VENCIMIENTO instead — 2027-02-28 for a cartola whose period ends 2026-06-30.
            text = subprocess.check_output(
                ["pdftotext", "-layout", str(p), "-"],
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
            move_inbox_duplicate(
                p,
                dry_run=dry_run,
                reason=f"{dest.relative_to(CFRASER)} already exists",
            )
            moved += 1
            continue
        if p.resolve() == dest.resolve():
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            shutil.move(str(p), str(dest))
        record_inbox_filed("checking_pdfs", dest, p)
        moved += 1
    return moved


def park_untracked_account_cartola(
    p: Path,
    hasta: str,
    product_label: str,
    account: str | None,
    cartola_no: str | None,
    *,
    dry_run: bool,
) -> int:
    """
    File a cartola of an account no importer models in `cartolas-otras-cuentas/`, named by its
    product, account tail, period end and cartola number, and say so: the bank mails these next
    to the tracked documents, and importing one as the tracked account would be wrong, while
    failing the run over a document nobody imports would block every other import.
    """
    tail = account.rsplit("-", 2)[1] if account and "-" in account else (account or "sin-cuenta")
    stem = f"{hasta} cartola {product_label} {tail}{cartola_no_suffix(cartola_no)}"
    dest = OTHER_ACCOUNTS_DIR / f"{stem}.pdf"
    if dest.exists() and p.resolve() != dest.resolve():
        move_inbox_duplicate(p, dry_run=dry_run, reason=f"{dest.relative_to(CFRASER)} already exists")
        return 1
    if p.resolve() == dest.resolve():
        return 0
    print(f"{p.name} -> {dest.relative_to(CFRASER)} (untracked account {account}: not imported)")
    _UNTRACKED_PARKED.append(f"{p.name} -> {dest.relative_to(CFRASER)}")
    if not dry_run:
        OTHER_ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(p), str(dest))
    return 1


# Untracked-account cartolas parked this run (reported in the run summary).
_UNTRACKED_PARKED: list[str] = []


def pdftotext_layout(path: Path) -> str | None:
    """`pdftotext -layout` text, or None when the PDF cannot be read (encrypted, damaged)."""
    proc = subprocess.run(
        ["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def decrypt_inbox_pdfs(dry_run: bool) -> int:
    """
    Decrypt, in place, every inbox PDF `pdftotext` cannot open, with the configured statement
    passwords (Santander encrypts cartolas as well as card statements since October 2026).

    Classification and every downstream parser read the decrypted text. A PDF no password opens
    is left as it is: the card pass then fails on it with the password hint, as before. A dry run
    decrypts nothing (and so cannot classify an encrypted attachment).
    """
    inbox = resolve_inbox_dir()
    if dry_run or not inbox.is_dir() or not qpdf_available():
        return 0
    load_repo_dotenv()
    n = 0
    for p in sorted(inbox.glob("*.pdf")):
        if pdftotext_layout(p) is not None or not pdf_is_encrypted(p):
            continue
        for pw in statement_pdf_passwords_to_try(p):
            ok, _msg = try_qpdf_decrypt_with_password(p, pw)
            if ok:
                print(f"decrypted: {p.name}")
                n += 1
                break
    return n


RE_LINEA_CARTOLA_NO = re.compile(r"^\d{4}-\d{2}-\d{2} cartola linea credito (\d+)\.pdf$", re.I)


def organize_santander_cartolas_by_text(dry_run: bool) -> tuple[int, list[str]]:
    """
    File inbox cartolas whose attachment name says nothing (`LCA_CTA_CTE_CRONO-<n>_<m>.pdf`,
    `C_MATICA_ONDEM-…`), by what the PDF prints: the product heading and the account in the header
    decide where it goes, the printed CARTOLA / DESDE / HASTA name it.

    - the configured cuenta corriente, in pesos → `cartolas-cuenta-corriente/`
    - the configured línea de crédito → `cartolas-linea-credito/` (an existing file with the same
      cartola number is the same document → `inbox/duplicates/`)
    - an ignored account → `cartolas-otras-cuentas/` (as `file_ignored_account_cartola`)
    - a foreign-currency cuenta corriente («ME») → `cartolas-otras-cuentas/`, reported
    - any other peso cuenta corriente or línea de crédito → error, left in the inbox
    Cuenta vista cartolas are left to `organize_cuenta_vista` (run before this). A cartola without
    a readable header or account is an error, never a guess.
    """
    inbox = resolve_inbox_dir()
    errors: list[str] = []
    if not inbox.is_dir():
        return 0, errors
    moved = 0
    for p in sorted(inbox.glob("*.pdf")):
        if is_claimed(p):
            continue
        if (
            is_checking_cartola_inbox_name(p.name)
            or is_cuenta_vista_inbox_name(p.name)
            or is_linea_credito_cartola_inbox_name(p.name)
        ):
            continue
        text = pdftotext_layout(p)
        if text is None:
            continue
        product = cartola_product(text)
        if product is None or product == CARTOLA_PRODUCT_CUENTA_VISTA:
            continue
        claim(p)
        header = peek_cartola_header(text)
        account = peek_cartola_account(text)
        if not header or not account:
            missing = "CARTOLA/DESDE/HASTA header" if not header else "account number"
            errors.append(f"{p.name}: {product} cartola without a printed {missing}")
            continue
        cartola_no, _desde, hasta = header
        digits = account_digits(account)
        if is_ignored_cartola_account(account):
            moved += file_ignored_account_cartola(p, hasta, account, dry_run=dry_run)
            continue
        if product == CARTOLA_PRODUCT_CHECKING_FOREIGN:
            # A foreign-currency cuenta corriente has no cartola importer: parked, reported, never imported.
            moved += park_untracked_account_cartola(p, hasta, "cuenta corriente me", account, cartola_no, dry_run=dry_run)
            continue
        if product == CARTOLA_PRODUCT_CHECKING and digits == account_digits(SANTANDER_CHECKING_CARTOLA_ACCOUNT):
            folder, stem, manifest = CART_DIR, f"{hasta} cartola cuenta corriente{cartola_no_suffix(cartola_no)}", "checking_pdfs"
        elif product == CARTOLA_PRODUCT_LINEA_CREDITO and digits == account_digits(SANTANDER_LINEA_CREDITO_ACCOUNT):
            folder, stem, manifest = LINEA_DIR, f"{hasta} cartola linea credito{cartola_no_suffix(cartola_no)}", None
        else:
            key = (
                "santander_checking_cartola_account"
                if product == CARTOLA_PRODUCT_CHECKING
                else "santander_linea_credito_account"
            )
            errors.append(
                f"{p.name}: {product} cartola of account {masked_account(account)}, which is neither {key} "
                "nor in santander_ignored_cartola_accounts — fix organize-identifiers.json or add the "
                "account to santander_ignored_cartola_accounts (left in the inbox)"
            )
            continue
        dest = folder / f"{stem}.pdf"
        same = dest if dest.exists() else None
        if same is None and folder == LINEA_DIR and cartola_no_suffix(cartola_no):
            # Older línea de crédito files are named by the attachment date, not HASTA: the cartola
            # number names the document.
            same = next(
                (q for q in sorted(LINEA_DIR.glob("*.pdf")) if RE_LINEA_CARTOLA_NO.match(q.name)
                 and RE_LINEA_CARTOLA_NO.match(q.name).group(1) == cartola_no),
                None,
            )
        if same is not None:
            move_inbox_duplicate(p, dry_run=dry_run, reason=f"{same.relative_to(CFRASER)} already exists")
            moved += 1
            continue
        print(f"{p.name} -> {dest.relative_to(CFRASER)}")
        if not dry_run:
            folder.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
        if manifest:
            record_inbox_filed(manifest, dest, p)
        moved += 1
    return moved, errors


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
    ap.add_argument(
        "--manifest",
        metavar="PATH",
        help="Write JSON manifest of PDFs filed from cfraser/inbox/ this run",
    )
    args = ap.parse_args()
    reset_inbox_manifest()
    _RUN_ERRORS.clear()
    manifest_path = Path(args.manifest) if args.manifest else None
    by_pdf = load_csv_by_pdf()
    n_decrypted = decrypt_inbox_pdfs(args.dry_run)
    # Vista PDFs in cfraser/inbox/ must be filed before credit-card organize reads the same inbox.
    n_vista = organize_cuenta_vista(args.dry_run)
    n_reloc_vista = relocate_misfiled_checking_from_vista(args.dry_run)
    n_linea_inbox = organize_linea_credito_cartolas_inbox(args.dry_run)
    n_check_inbox = organize_checking_cartolas_inbox(args.dry_run)
    n_text_cartolas, cartola_errors = organize_santander_cartolas_by_text(args.dry_run)
    n_cc, cc_errors = organize_credit_card(args.dry_run, by_pdf)
    cc_errors = [*_RUN_ERRORS, *cartola_errors, *cc_errors]
    n_clean, n_reloc = finalize_credit_card_layout(args.dry_run)
    n_cart = organize_cartolas(args.dry_run)
    print(
        f"decrypted: {n_decrypted} file(s); "
        f"cuenta-vista: {n_vista} file(s); vista→checking relocate: {n_reloc_vista} file(s); "
        f"linea-credito-inbox: {n_linea_inbox} file(s); checking-inbox: {n_check_inbox} file(s); "
        f"cartolas by text: {n_text_cartolas} file(s); "
        f"credit-card: {n_cc} file(s); "
        f"cc-clean (n): {n_clean}; cc-relocate: {n_reloc}; cartolas: {n_cart} file(s)"
    )
    for line in _UNTRACKED_PARKED:
        print(f"untracked-account cartola parked (not imported): {line}")
    write_inbox_manifest(manifest_path)
    if cc_errors:
        for err in cc_errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
