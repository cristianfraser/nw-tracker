"""Personal per-card config (real card last4s) — loaded from OUTSIDE git.

Consolidation redirects, statement-classification tokens, and BCI Lider last4s live in
`cfraser/cc-cards.json` (cfraser/ is gitignored) so the repo stays free of real card
numbers. A missing file is a valid empty registry (no personal cards configured: CI,
fresh clones). A present-but-malformed file raises. Tests inject synthetic cards via
`NW_TRACKER_CC_CARDS` (path to a JSON file, set before importing these modules).

Mirrors `server/src/ccCardRegistry.ts` — keep the key set in sync.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

CC_CARDS_PATH = Path(
    os.environ.get("NW_TRACKER_CC_CARDS", str(_REPO_ROOT / "cfraser" / "cc-cards.json"))
)

_DEFAULTS: dict = {
    "import_redirect_last4": {},
    "superseded_master_notes": [],
    "multicard_marker_tokens": [],
    "legacy_group_b_tokens": [],
    "lider_filename_last4s": [],
    "reconcile_skip_last4s": [],
    "reconcile_primary_last4s": [],
}


def _load() -> dict:
    if not CC_CARDS_PATH.is_file():
        return dict(_DEFAULTS)
    data = json.loads(CC_CARDS_PATH.read_text(encoding="utf-8"))
    unknown = sorted(set(data) - set(_DEFAULTS))
    if unknown:
        raise SystemExit(f"{CC_CARDS_PATH}: unknown keys: {', '.join(unknown)}")
    return {**_DEFAULTS, **data}


CC_CARDS = _load()

IMPORT_REDIRECT_LAST4: dict[str, str] = CC_CARDS["import_redirect_last4"]
MULTICARD_MARKER_TOKENS: list[str] = CC_CARDS["multicard_marker_tokens"]
LEGACY_GROUP_B_TOKENS: list[str] = CC_CARDS["legacy_group_b_tokens"]
LIDER_FILENAME_LAST4S: list[str] = CC_CARDS["lider_filename_last4s"]
RECONCILE_SKIP_LAST4S: list[str] = CC_CARDS["reconcile_skip_last4s"]
RECONCILE_PRIMARY_LAST4S: list[str] = CC_CARDS["reconcile_primary_last4s"]
