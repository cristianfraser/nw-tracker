"""Personal per-card config (real card last4s) — loaded from OUTSIDE git.

Consolidation redirects, statement-classification tokens, and BCI Lider last4s live in
`cfraser/cc-cards.json` (cfraser/ is gitignored) so the repo stays free of real card
numbers. A missing file is a valid empty registry (no personal cards configured: CI,
fresh clones). A present file must satisfy the shared schema
(`server/contracts/data/schemas/cc-cards.schema.json`, the one `server/src/ccCardRegistry.ts`
parses with too); a malformed or unknown key raises. Tests inject synthetic cards via
`NW_TRACKER_CC_CARDS` (path to a JSON file, set before importing these modules).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import shared_schema

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

CC_CARDS_PATH = Path(
    os.environ.get("NW_TRACKER_CC_CARDS", str(_REPO_ROOT / "cfraser" / "cc-cards.json"))
)

_SCHEMA = shared_schema.load_schema("cc-cards")
# Every key is optional; a missing one takes the schema's default (empty).
_DEFAULTS: dict = {key: prop["default"] for key, prop in _SCHEMA["properties"].items()}


def _load() -> dict:
    if not CC_CARDS_PATH.is_file():
        return {k: (dict(v) if isinstance(v, dict) else list(v)) for k, v in _DEFAULTS.items()}
    data = json.loads(CC_CARDS_PATH.read_text(encoding="utf-8"))
    try:
        shared_schema.validate(data, _SCHEMA, str(CC_CARDS_PATH))
    except shared_schema.SchemaError as e:
        raise SystemExit(str(e))
    return {**_DEFAULTS, **data}


CC_CARDS = _load()

IMPORT_REDIRECT_LAST4: dict[str, str] = CC_CARDS["import_redirect_last4"]
MULTICARD_MARKER_TOKENS: list[str] = CC_CARDS["multicard_marker_tokens"]
LEGACY_GROUP_B_TOKENS: list[str] = CC_CARDS["legacy_group_b_tokens"]
LIDER_FILENAME_LAST4S: list[str] = CC_CARDS["lider_filename_last4s"]
RECONCILE_SKIP_LAST4S: list[str] = CC_CARDS["reconcile_skip_last4s"]
RECONCILE_PRIMARY_LAST4S: list[str] = CC_CARDS["reconcile_primary_last4s"]
