"""
qpdf helpers for Santander credit-card statement PDFs.

Rewrites or decrypts PDFs so `pdftotext` / pypdf get a normal text layer (avoids
Preview/Chrome “Save as PDF”, which often breaks font encoding).

Install: `brew install qpdf poppler`

Optional env (encrypted email attachments): `CC_STATEMENT_PDF_PASSWORD`
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def load_repo_dotenv() -> None:
    """Load repo-root `.env` when keys are not already set (e.g. CC_STATEMENT_PDF_PASSWORD)."""
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


READABLE_MARKERS: Tuple[str, ...] = (
    "ESTADO DE CUENTA",
    "ESTADO DE CUENTA INTERNACIONAL",
    "FECHA ESTADO DE CUENTA",
    "MONEDA NACIONAL DE TARJETA",
    "MONTO US$",
    "INFORMACION DE TRANSACCIONES",
)


def statement_pdf_password() -> Optional[str]:
    load_repo_dotenv()
    raw = os.environ.get("CC_STATEMENT_PDF_PASSWORD", "").strip()
    return raw or None


def is_readable_cc_statement_text(text: str) -> bool:
    upper = re.sub(r"\s+", " ", str(text or "")).upper()
    if len(upper) < 40:
        return False
    return any(marker in upper for marker in READABLE_MARKERS)


def qpdf_available() -> bool:
    return shutil.which("qpdf") is not None


def peek_pdf_text(path: Path) -> str:
    try:
        return subprocess.check_output(
            ["pdftotext", str(path), "-"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
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
        return False, "encrypted; set CC_STATEMENT_PDF_PASSWORD or decrypt manually"

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
    pw = password if password is not None else statement_pdf_password()
    ok, msg = try_qpdf_repair_pdf(path, password=pw)
    if not ok:
        return f"repair failed ({msg})"
    text2 = peek_pdf_text(path)
    if is_readable_cc_statement_text(text2):
        return f"repaired ({msg})"
    return (
        f"repaired ({msg}) but text still unreadable — "
        "re-download from Santander (do not Save as PDF from Preview)"
    )


def repair_unreadable_pdfs_in_dir(
    directory: Path,
    password: Optional[str] = None,
) -> List[Tuple[str, str]]:
    """Scan `*.pdf` in directory; attempt qpdf on unreadable files. Returns (name, message)."""
    if not directory.is_dir():
        return []
    pw = password if password is not None else statement_pdf_password()
    results: List[Tuple[str, str]] = []
    for path in sorted(directory.rglob("*.pdf")):
        if "unreadable" in path.parts:
            continue
        if path.stem.endswith("-CORRUPT"):
            continue
        note = ensure_readable_for_parse(path, password=pw)
        if note:
            results.append((path.name, note))
    return results
