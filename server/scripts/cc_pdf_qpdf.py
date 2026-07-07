"""
qpdf helpers for credit-card statement PDFs (Santander + BCI Lider).

Rewrites or decrypts PDFs so `pdftotext` / pypdf get a normal text layer (avoids
Preview/Chrome “Save as PDF”, which often breaks font encoding).

Install: `brew install qpdf poppler`

Optional env (encrypted email attachments):
  `SANTANDER_CC_STATEMENT_PDF_PASSWORD`
  `LIDER_CC_STATEMENT_PDF_PASSWORD`
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PDF_DEPS = SCRIPT_DIR / ".pdf_deps"
if PDF_DEPS.is_dir() and str(PDF_DEPS) not in sys.path:
    sys.path.insert(0, str(PDF_DEPS))

import cc_cards
from cc_pdf_ocr import extract_cc_pdf_ocr_flat, peek_pdf_text_pdftotext

REPO_ROOT = SCRIPT_DIR.parent.parent

SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV = "SANTANDER_CC_STATEMENT_PDF_PASSWORD"
LIDER_CC_STATEMENT_PDF_PASSWORD_ENV = "LIDER_CC_STATEMENT_PDF_PASSWORD"
LEGACY_CC_STATEMENT_PDF_PASSWORD_ENV = "CC_STATEMENT_PDF_PASSWORD"


def load_repo_dotenv() -> None:
    """Load repo-root `.env` when keys are not already set."""
    env_path = REPO_ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        if "=" not in t:
            continue
        key, _, val = t.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and os.environ.get(key) is None:
            os.environ[key] = val


SANTANDER_READABLE_MARKERS: Tuple[str, ...] = (
    "ESTADO DE CUENTA",
    "ESTADO DE CUENTA INTERNACIONAL",
    "FECHA ESTADO DE CUENTA",
    "MONEDA NACIONAL DE TARJETA",
    "MONTO US$",
    "INFORMACION DE TRANSACCIONES",
)


def _ascii_upper(text: str) -> str:
    folded = unicodedata.normalize("NFD", str(text or ""))
    stripped = "".join(c for c in folded if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", stripped).upper()


def split_password_env(raw: str) -> List[str]:
    """One or more passwords from env (comma/semicolon-separated)."""
    if not str(raw or "").strip():
        return []
    parts = re.split(r"[,;]+", str(raw))
    out: List[str] = []
    seen: set[str] = set()
    for part in parts:
        pw = part.strip()
        if pw and pw not in seen:
            seen.add(pw)
            out.append(pw)
    return out


def santander_cc_statement_pdf_passwords() -> List[str]:
    load_repo_dotenv()
    pws = split_password_env(
        os.environ.get(SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV, "")
    )
    if not pws:
        pws = split_password_env(
            os.environ.get(LEGACY_CC_STATEMENT_PDF_PASSWORD_ENV, "")
        )
    return pws


def lider_cc_statement_pdf_passwords() -> List[str]:
    load_repo_dotenv()
    return split_password_env(os.environ.get(LIDER_CC_STATEMENT_PDF_PASSWORD_ENV, ""))


def santander_cc_statement_pdf_password() -> Optional[str]:
    pws = santander_cc_statement_pdf_passwords()
    return pws[0] if pws else None


def lider_cc_statement_pdf_password() -> Optional[str]:
    pws = lider_cc_statement_pdf_passwords()
    return pws[0] if pws else None


def statement_pdf_password() -> Optional[str]:
    """Santander password only (legacy name for callers that pass a single password)."""
    return santander_cc_statement_pdf_password()


def is_readable_santander_cc_statement_text(text: str) -> bool:
    upper = re.sub(r"\s+", " ", str(text or "")).upper()
    if len(upper) < 40:
        return False
    return any(marker in upper for marker in SANTANDER_READABLE_MARKERS)


def is_readable_bci_lider_statement_text(text: str) -> bool:
    upper = _ascii_upper(text)
    if "WORLDMEMBER" in upper or "MONTO ORIGEN OPERAC" in upper or "W. LIMITED" in upper:
        return False
    if "BANCO DE CREDITO" in upper:
        return True
    compact = upper.replace(" ", "")
    if re.search(r"NUMEROTARJETA[X]{8,}\d{4}", compact):
        return "MONTO TOTAL FACTURADO" in upper and "PERIODO FACTURADO" in upper
    return False


def is_readable_cc_statement_text(text: str) -> bool:
    return is_readable_santander_cc_statement_text(
        text
    ) or is_readable_bci_lider_statement_text(text)


def peek_bci_lider_meta(text: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (statement close ISO date, card last4) from decrypted Lider PDF text."""
    iso: Optional[str] = None
    m_hasta = re.search(
        r"PER[IÍ]ODO\s+FACTURADO\s+HASTA\s+(\d{2}/\d{2}/\d{4})", text, re.I
    )
    if m_hasta:
        iso = _dd_mm_yyyy_to_iso(m_hasta.group(1))
    if not iso:
        m_pay = re.search(r"PAGAR\s+HASTA\s+(\d{2}/\d{2}/\d{4})", text, re.I)
        if m_pay:
            iso = _dd_mm_yyyy_to_iso(m_pay.group(1))
    if not iso:
        m_stmt = re.search(r"FECHA\s+ESTADO\s+DE\s+CUENTA\s+(\d{2}/\d{2}/\d{4})", text, re.I)
        if m_stmt:
            iso = _dd_mm_yyyy_to_iso(m_stmt.group(1))
    compact = _ascii_upper(text).replace(" ", "")
    m_l4 = re.search(r"NUMEROTARJETA[X]{8,}(\d{4})", compact)
    last4 = m_l4.group(1) if m_l4 else None
    return iso, last4


def _dd_mm_yyyy_to_iso(raw: str) -> Optional[str]:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(raw or "").strip())
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def is_inbox_attachment_style_pdf(path: Path) -> bool:
    """Email attachment ids like `155028273.pdf` (no issuer in the name)."""
    return bool(re.fullmatch(r"\d+\.pdf", path.name, re.I))


def is_likely_lider_cc_pdf(path: Path, text: str = "") -> bool:
    name = path.name.lower()
    if is_inbox_attachment_style_pdf(path):
        return True
    if "lider" in name or "bci" in name or any(l4 in name for l4 in cc_cards.LIDER_FILENAME_LAST4S):
        return True
    if text.strip() and is_readable_bci_lider_statement_text(text):
        return True
    return False


def all_configured_statement_pdf_passwords() -> List[str]:
    """Every non-empty CC statement password from env (deduped, stable order)."""
    seen: set[str] = set()
    out: List[str] = []
    for pw in (
        *santander_cc_statement_pdf_passwords(),
        *lider_cc_statement_pdf_passwords(),
    ):
        if pw not in seen:
            seen.add(pw)
            out.append(pw)
    return out


def statement_pdf_passwords_to_try(path: Path, text: str = "") -> List[str]:
    """Password order when decrypting: likely issuer first, then the rest."""
    all_pw = all_configured_statement_pdf_passwords()
    if not all_pw:
        return []
    lider_list = lider_cc_statement_pdf_passwords()
    santander_list = santander_cc_statement_pdf_passwords()
    if is_likely_lider_cc_pdf(path, text):
        preferred = [*lider_list, *santander_list]
    else:
        preferred = [*santander_list, *lider_list]
    out: List[str] = []
    seen: set[str] = set()
    for pw in preferred + all_pw:
        if pw in seen:
            continue
        seen.add(pw)
        out.append(pw)
    return out


def is_qpdf_invalid_password_message(msg: str) -> bool:
    lower = str(msg or "").lower()
    return "invalid password" in lower or "incorrect password" in lower


def encrypted_password_env_hint() -> str:
    return (
        f"set {SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV} "
        f"and/or {LIDER_CC_STATEMENT_PDF_PASSWORD_ENV}"
    )


def qpdf_available() -> bool:
    return shutil.which("qpdf") is not None


def peek_pdf_text(path: Path) -> str:
    text = peek_pdf_text_pdftotext(path).strip()
    if text:
        return text
    try:
        return extract_cc_pdf_ocr_flat(path)
    except Exception:
        return ""


def pdf_is_encrypted(path: Path) -> bool:
    if not qpdf_available():
        return False
    try:
        out = subprocess.check_output(
            ["qpdf", "--show-encryption", str(path)],
            text=True,
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError:
        return False
    return "not encrypted" not in out.lower()


def try_qpdf_decrypt_with_password(path: Path, password: str) -> Tuple[bool, str]:
    """Decrypt with an explicit password (even when --show-encryption is inconclusive)."""
    if not path.is_file():
        return False, "missing"
    if not qpdf_available():
        return False, "qpdf not installed (brew install qpdf)"

    with tempfile.NamedTemporaryFile(
        suffix=".pdf", delete=False, dir=str(path.parent)
    ) as tmp:
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            "qpdf",
            "--warning-exit-0",
            f"--password={password}",
            "--decrypt",
            str(path),
            str(tmp_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            tail = detail[-1] if detail else f"exit {proc.returncode}"
            return False, tail
        tmp_path.replace(path)
        return True, "decrypted"
    except OSError as e:
        return False, str(e)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def try_qpdf_repair_pdf(
    path: Path,
    password: Optional[str] = None,
) -> Tuple[bool, str]:
    """
    Decrypt (if needed) and rewrite PDF via qpdf, replacing the file in place.
    Returns (success, message). success means qpdf exited 0; text may still be unreadable.
    """
    if not path.is_file():
        return False, "missing"
    if not qpdf_available():
        return False, "qpdf not installed (brew install qpdf)"

    encrypted = pdf_is_encrypted(path)
    if encrypted and not password:
        return False, f"encrypted; {encrypted_password_env_hint()} or decrypt manually"

    with tempfile.NamedTemporaryFile(
        suffix=".pdf", delete=False, dir=str(path.parent)
    ) as tmp:
        tmp_path = Path(tmp.name)

    try:
        cmd: List[str] = ["qpdf", "--warning-exit-0"]
        if encrypted:
            cmd.append(f"--password={password}")
            cmd.append("--decrypt")
        cmd.extend([str(path), str(tmp_path)])
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            tail = detail[-1] if detail else f"exit {proc.returncode}"
            return False, tail
        tmp_path.replace(path)
        return True, "decrypted" if encrypted else "rewritten"
    except OSError as e:
        return False, str(e)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def try_qpdf_repair_pdf_encrypted(path: Path) -> Tuple[bool, str]:
    """Try every configured password until decrypt succeeds."""
    return try_qpdf_repair_with_all_passwords(path)


def try_qpdf_repair_with_all_passwords(
    path: Path,
    *,
    prefer_password: Optional[str] = None,
) -> Tuple[bool, str]:
    """
    Attempt qpdf repair: optional passwordless rewrite, then every configured password.
    Never stops after the first wrong password.
    """
    text = peek_pdf_text(path)
    passwords = statement_pdf_passwords_to_try(path, text)
    if prefer_password and prefer_password not in passwords:
        passwords = [prefer_password, *passwords]

    encrypted = pdf_is_encrypted(path)
    last_msg = ""

    if not encrypted:
        ok, msg = try_qpdf_repair_pdf(path, password=None)
        if ok:
            if is_readable_cc_statement_text(peek_pdf_text(path)):
                return True, msg
            last_msg = msg

    if not passwords:
        if encrypted:
            return False, f"encrypted; {encrypted_password_env_hint()}"
        return False, last_msg or "unreadable"

    for pw in passwords:
        ok, msg = try_qpdf_decrypt_with_password(path, pw)
        if ok:
            return True, msg
        last_msg = msg
        if is_qpdf_invalid_password_message(msg):
            continue

    return False, last_msg or f"encrypted; {encrypted_password_env_hint()}"


def format_repair_failure_message(path: Path, last_msg: str) -> str:
    """Human-readable repair failure (hints when only one password is configured)."""
    n = len(statement_pdf_passwords_to_try(path, peek_pdf_text(path)))
    base = last_msg or "unknown error"
    if n <= 1 and pdf_is_encrypted(path):
        hints = [encrypted_password_env_hint()]
        if is_likely_lider_cc_pdf(path):
            hints.append(
                f"for BCI Lider PDFs set {LIDER_CC_STATEMENT_PDF_PASSWORD_ENV} "
                f"(or add a second password comma-separated in "
                f"{LEGACY_CC_STATEMENT_PDF_PASSWORD_ENV})"
            )
        return f"{base}; tried {n} password(s); {' — '.join(hints)}"
    if n > 1:
        return f"{base}; tried {n} passwords"
    return base


def ensure_readable_for_parse(
    path: Path,
    password: Optional[str] = None,
) -> Optional[str]:
    """
    If PDF text is not readable, attempt qpdf repair once.
    Returns a log line when repair was attempted; None if already readable.
    """
    if path.stem.endswith("-CORRUPT"):
        return None
    text = peek_pdf_text(path)
    if is_readable_cc_statement_text(text):
        return None

    ok, msg = try_qpdf_repair_with_all_passwords(
        path, prefer_password=password
    )

    if not ok:
        detail = format_repair_failure_message(path, msg)
        return f"repair failed ({detail})"
    text2 = peek_pdf_text(path)
    if is_readable_cc_statement_text(text2):
        return None
    try:
        ocr = extract_cc_pdf_ocr_flat(path)
        if is_readable_cc_statement_text(ocr):
            return None
    except Exception:
        pass
    lider = is_readable_bci_lider_statement_text(text2)
    bank = "Lider/BCI" if lider else "Santander"
    return (
        f"repaired ({msg}) but text still unreadable — "
        f"re-download from {bank} (do not Save as PDF from Preview)"
    )


def repair_unreadable_pdfs_in_dir(
    directory: Path,
    password: Optional[str] = None,
) -> List[Tuple[str, str]]:
    """Scan `*.pdf` in directory; attempt qpdf on unreadable files. Returns (name, message)."""
    if not directory.is_dir():
        return []
    results: List[Tuple[str, str]] = []
    for path in sorted(directory.rglob("*.pdf")):
        if "unreadable" in path.parts:
            continue
        if "duplicates" in path.parts:
            continue
        if path.stem.endswith("-CORRUPT"):
            continue
        note = ensure_readable_for_parse(
            path, password=password if password is not None else None
        )
        if note:
            results.append((path.name, note))
    return results
