"""
The Tesseract model every OCR'd document is read with.

PyMuPDF's OCR reads the `eng.traineddata` under `TESSDATA_PREFIX`, and what it reads depends on
that file: another build of the English model (MacPorts' `tesseract-eng` 4.1.0 against Homebrew's)
dropped 48 lines from 15 scanned card statements and failed the statement import (2026-11-10).
The stored parses were made with the model named here, so the OCR refuses any other.

To change the model: re-parse every scanned document with the new one, check the result, then
update the hash.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

# Homebrew `tesseract` 5.5 `eng.traineddata` (tessdata_fast, 4.113.088 bytes).
EXPECTED_ENG_TRAINEDDATA_SHA256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"

TESSDATA_CANDIDATE_DIRS: Tuple[str, ...] = (
    "/opt/homebrew/share/tessdata",
    "/opt/local/share/tessdata",
    "/usr/local/share/tessdata",
    "/usr/share/tessdata",
)


def _eng_model_sha256(prefix: str) -> Optional[str]:
    model = Path(prefix) / "eng.traineddata"
    if not model.is_file():
        return None
    return hashlib.sha256(model.read_bytes()).hexdigest()


def require_tessdata_prefix(
    env_prefix: Optional[str] = None,
    candidates: Sequence[str] = TESSDATA_CANDIDATE_DIRS,
    expected_sha256: str = EXPECTED_ENG_TRAINEDDATA_SHA256,
) -> str:
    """
    The tessdata folder holding the expected English model.

    `TESSDATA_PREFIX`, when set, is the only folder considered; otherwise the first standard
    folder whose model matches. Raises when none does, naming what each folder holds.
    """
    if env_prefix is None:
        env_prefix = os.environ.get("TESSDATA_PREFIX", "").strip()
    dirs: List[str] = [env_prefix] if env_prefix else list(candidates)
    seen: List[str] = []
    for prefix in dirs:
        found = _eng_model_sha256(prefix)
        if found == expected_sha256:
            return prefix
        seen.append(f"{prefix}: {'no eng.traineddata' if found is None else 'sha256 ' + found[:16]}")
    source = "TESSDATA_PREFIX" if env_prefix else "the standard tessdata folders"
    raise RuntimeError(
        "OCR model mismatch: no eng.traineddata with sha256 "
        f"{expected_sha256[:16]}… in {source} ({'; '.join(seen)}). "
        "Scanned documents were parsed with that model and another one reads them differently. "
        "Copy the expected eng.traineddata into a folder and set TESSDATA_PREFIX to it "
        "(see ingest/python/ocr_tessdata.py)."
    )


def use_expected_tessdata() -> str:
    """Point PyMuPDF's OCR at the expected model; call before `get_textpage_ocr`."""
    prefix = require_tessdata_prefix()
    os.environ["TESSDATA_PREFIX"] = prefix
    return prefix
