#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Which card-statement parses are accepted, and what a newer parser would read differently.

A parse is **accepted** once the statements import that followed it succeeded: the parser lists
the cache entries a run used (`parse-manifest.json`, beside the CSV it wrote) and the inbox
pipeline, after the import, records them here (`accepted.json`: PDF sha256 → the parser version
that read it). The parser keeps serving an accepted entry whatever its own version is now, so a
parser edit re-reads only the PDFs no accepted parse covers.

Old statements are re-read by the **audit** (`parse-cc-statement-pdfs.py --audit`), which parses
every accepted entry of an older version with the current parser and compares: an identical
result moves the entry to the current version, a different one is reported and, with `--adopt`,
replaces the entry (to be accepted again by the next import).

  npm run accept:cc-parses -w nw-tracker-ingest                # after a successful import
  npm run accept:cc-parses -w nw-tracker-ingest -- --bootstrap # once: accept the cache as it is
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
CFRASER_DIR = SCRIPT_DIR.parent.parent / "cfraser"
PARSE_CACHE_DIR = Path(
    os.environ.get("CC_PARSE_CACHE_DIR", str(CFRASER_DIR / "cc-statements-parsing-output"))
)

# The fields of a cache entry that are the parse itself (everything but its identity).
PARSE_PAYLOAD_FIELDS: Tuple[str, ...] = (
    "source_pdf",
    "card_group",
    "effective_group",
    "parser",
    "meta",
    "parsed",
    "full",
    "layout",
)
# `source_pdf` is the name of the copy that was read (the same bytes may be filed under two
# names), not part of the reading.
COMPARED_FIELDS: Tuple[str, ...] = tuple(f for f in PARSE_PAYLOAD_FIELDS if f != "source_pdf")


def per_pdf_dir(cache_dir: Path) -> Path:
    return cache_dir / "per-pdf"


def audit_dir(cache_dir: Path) -> Path:
    return cache_dir / "per-pdf-audit"


def accepted_path(cache_dir: Path) -> Path:
    return cache_dir / "accepted.json"


def manifest_path(cache_dir: Path) -> Path:
    return cache_dir / "parse-manifest.json"


def audit_state_path(cache_dir: Path) -> Path:
    return cache_dir / "audit-state.json"


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_accepted(cache_dir: Path) -> Dict[str, Dict[str, Any]]:
    """PDF sha256 → {parser_version, accepted_at, source_pdf}; empty before the first acceptance."""
    path = accepted_path(cache_dir)
    if not path.is_file():
        return {}
    return dict(json.loads(path.read_text(encoding="utf-8")))


def save_accepted(cache_dir: Path, accepted: Dict[str, Dict[str, Any]]) -> None:
    _write_json(accepted_path(cache_dir), accepted)


def cache_entry_serves(
    entry: Dict[str, Any],
    pdf_hash: str,
    parser_version: str,
    accepted: Dict[str, Dict[str, Any]],
) -> bool:
    """
    Whether a cache entry answers for this PDF: read by the current parser, or accepted as the
    parser version it was read with (an acceptance of another version of the entry does not count).
    """
    if str(entry.get("pdf_sha256") or "") != pdf_hash:
        return False
    entry_version = str(entry.get("parser_version") or "")
    if entry_version == parser_version:
        return True
    return str((accepted.get(pdf_hash) or {}).get("parser_version") or "") == entry_version != ""


def write_manifest(cache_dir: Path, csv_path: Path, entries: Iterable[Dict[str, str]]) -> None:
    """The cache entries one parser run used, tied to the CSV it wrote."""
    _write_json(
        manifest_path(cache_dir),
        {"csv": str(csv_path), "csv_sha256": file_sha256(csv_path), "entries": list(entries)},
    )


def clear_manifest(cache_dir: Path) -> None:
    path = manifest_path(cache_dir)
    if path.exists():
        path.unlink()


def accept_manifest(cache_dir: Path, now: Optional[datetime] = None) -> int:
    """
    Record the last parser run's entries as accepted. Refuses when the CSV is no longer the one
    that run wrote (the import read something else). Returns how many entries changed.
    """
    path = manifest_path(cache_dir)
    if not path.is_file():
        raise RuntimeError(f"no {path.name} in {cache_dir}: run parse:cc-pdfs first")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    csv_path = Path(manifest["csv"])
    if not csv_path.is_file() or file_sha256(csv_path) != manifest["csv_sha256"]:
        raise RuntimeError(
            f"{csv_path} is not the file the last parser run wrote; nothing accepted (run parse:cc-pdfs again)"
        )
    stamp = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    accepted = load_accepted(cache_dir)
    changed = 0
    for e in manifest["entries"]:
        current = accepted.get(e["pdf_sha256"])
        if current and current.get("parser_version") == e["parser_version"]:
            continue
        accepted[e["pdf_sha256"]] = {
            "parser_version": e["parser_version"],
            "accepted_at": stamp,
            "source_pdf": e["source_pdf"],
        }
        changed += 1
    if changed:
        save_accepted(cache_dir, accepted)
    return changed


def bootstrap_accept_cache(cache_dir: Path, now: Optional[datetime] = None) -> int:
    """
    Accept every cache entry as it is. For the one time acceptance starts on a store whose
    statements were all imported by the pipeline before parses were tracked.
    """
    if accepted_path(cache_dir).is_file():
        raise RuntimeError(f"{accepted_path(cache_dir)} exists: acceptance already started here")
    stamp = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    accepted: Dict[str, Dict[str, Any]] = {}
    for entry_path in sorted(per_pdf_dir(cache_dir).glob("*.json")):
        entry = json.loads(entry_path.read_text(encoding="utf-8"))
        pdf_hash = str(entry.get("pdf_sha256") or "")
        version = str(entry.get("parser_version") or "")
        if pdf_hash != entry_path.stem or not version:
            raise RuntimeError(f"{entry_path} is not a parse cache entry")
        accepted[pdf_hash] = {
            "parser_version": version,
            "accepted_at": stamp,
            "source_pdf": str(entry.get("source_pdf") or ""),
        }
    save_accepted(cache_dir, accepted)
    return len(accepted)


def parse_payload(entry: Dict[str, Any]) -> Dict[str, Any]:
    """An entry's parse, as JSON stores it (so a fresh parse and a stored one compare equal)."""
    return json.loads(json.dumps({k: entry.get(k) for k in PARSE_PAYLOAD_FIELDS}, ensure_ascii=False))


def describe_parse_difference(old: Dict[str, Any], new: Dict[str, Any]) -> List[str]:
    """What a newer parser reads differently, one line per field; empty when nothing."""
    a, b = parse_payload(old), parse_payload(new)
    lines: List[str] = []
    for field in COMPARED_FIELDS:
        if a[field] == b[field]:
            continue
        if field == "parsed":
            rows_a, rows_b = list(a[field] or []), list(b[field] or [])
            pool = [json.dumps(r, sort_keys=True, ensure_ascii=False) for r in rows_a]
            added = 0
            for r in rows_b:
                key = json.dumps(r, sort_keys=True, ensure_ascii=False)
                if key in pool:
                    pool.remove(key)
                else:
                    added += 1
            lines.append(
                f"lines: {len(rows_a)} → {len(rows_b)} ({len(pool)} no longer read, {added} new or changed)"
            )
        elif field == "meta":
            meta_a, meta_b = dict(a[field] or {}), dict(b[field] or {})
            keys = sorted(k for k in set(meta_a) | set(meta_b) if meta_a.get(k) != meta_b.get(k))
            shown = ", ".join(f"{k}: {meta_a.get(k)!r} → {meta_b.get(k)!r}" for k in keys[:6])
            more = f" (+{len(keys) - 6} more)" if len(keys) > 6 else ""
            lines.append(f"header: {shown}{more}")
        elif field in ("full", "layout"):
            lines.append(f"{field} text: {len(str(a[field] or ''))} → {len(str(b[field] or ''))} characters")
        else:
            lines.append(f"{field}: {a[field]!r} → {b[field]!r}")
    return lines


def stale_accepted_entries(
    cache_dir: Path, parser_version: str
) -> List[Tuple[str, Dict[str, Any]]]:
    """(PDF sha256, cache entry) for every accepted parse an older parser version read."""
    accepted = load_accepted(cache_dir)
    out: List[Tuple[str, Dict[str, Any]]] = []
    for pdf_hash, record in sorted(accepted.items()):
        if record.get("parser_version") == parser_version:
            continue
        entry_path = per_pdf_dir(cache_dir) / f"{pdf_hash}.json"
        if not entry_path.is_file():
            continue
        entry = json.loads(entry_path.read_text(encoding="utf-8"))
        if cache_entry_serves(entry, pdf_hash, parser_version, accepted):
            out.append((pdf_hash, entry))
    return out


def report_step_problems(problems: List[str]) -> None:
    """Tell the run that started this command why it failed (`NW_INGEST_STEP_RESULT`); a no-op by hand."""
    file = os.environ.get("NW_INGEST_STEP_RESULT")
    if not file:
        return
    path = Path(file)
    current = json.loads(path.read_text(encoding="utf-8") or "{}") if path.is_file() else {}
    path.write_text(json.dumps({**current, "problems": problems}), encoding="utf-8")


def main(argv: List[str]) -> int:
    try:
        if "--bootstrap" in argv:
            n = bootstrap_accept_cache(PARSE_CACHE_DIR)
            print(f"# accepted the {n} cached parse(s) as they are")
        else:
            n = accept_manifest(PARSE_CACHE_DIR)
            print(f"# accepted parses: {n} new or re-read")
    except RuntimeError as e:
        print(f"# FAIL: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
