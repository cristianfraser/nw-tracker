#!/usr/bin/env python3
"""Parse staged grocery receipts — e-mail boleta PDFs and photos of paper receipts — into
per-receipt parsed.json files that `groceryReceiptsImport.ts` imports.

Usage (repo root):
  python3 server/scripts/parse-grocery-receipts.py            # parse new/changed staged receipts
  python3 server/scripts/parse-grocery-receipts.py --check    # parse everything, write nothing
  python3 server/scripts/parse-grocery-receipts.py --force    # re-parse all
  --lider-root DIR / --generic-root DIR                       # override a staging root (tests)

Roots mirror `defaultStagingRoots` in groceryReceiptsImport.ts:
  * cfraser/lider-boletas/staged/<dir>/Boleta.pdf   — fetch:lider-boletas output (Lider e-mail)
  * cfraser/grocery-receipts/staged/<dir>/meta.json — the generic root; `original_file` names
    the document (PDF or photo). A photo goes through OCR (grocery_receipt_text.py — ocr.json +
    ocr.txt cached beside it; ocr.corrected.txt, when present, is what gets parsed).

The chain is detected from the issuer RUT in the text (grocery_receipt_parse.py) and the
chain's parser is fail-fast (a receipt that does not balance, or whose article count disagrees
with the printed one, is reported with the delta and NOT written). Exit status = number of
failures, so the inbox pipeline stops instead of importing a partial corpus.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from grocery_receipt_model import ReceiptParseError  # noqa: E402
from grocery_receipt_parse import parse_receipt_text  # noqa: E402
from grocery_receipt_text import sha256_text, text_for_document  # noqa: E402

REPO_ROOT = SCRIPT_DIR.parents[1]
LIDER_ROOT = REPO_ROOT / "cfraser" / "lider-boletas" / "staged"
GENERIC_ROOT = REPO_ROOT / "cfraser" / "grocery-receipts" / "staged"

# 3 (2026-09): chain registry + `chain`/`text_source`/`ignored_lines` in parsed.json, OCR
# tolerances in the Lider parser, article-count hard check.
PARSER_VERSION = 3


@dataclass(frozen=True)
class StagedDocument:
    root: str  # "lider_email" | "generic"
    dir: Path
    document: Path


def staged_documents(lider_root: Path, generic_root: Path) -> tuple[list[StagedDocument], list[tuple[str, str]]]:
    docs: list[StagedDocument] = []
    errors: list[tuple[str, str]] = []
    if lider_root.is_dir():
        for d in sorted(lider_root.iterdir()):
            pdf = d / "Boleta.pdf"
            if d.is_dir() and pdf.is_file():
                docs.append(StagedDocument("lider_email", d, pdf))
    if generic_root.is_dir():
        for d in sorted(generic_root.iterdir()):
            meta_file = d / "meta.json"
            if not d.is_dir() or not meta_file.is_file():
                continue
            try:
                meta = json.loads(meta_file.read_text())
            except json.JSONDecodeError as e:
                errors.append((d.name, f"meta.json is not valid JSON: {e}"))
                continue
            original = meta.get("original_file")
            if not original or not (d / original).is_file():
                errors.append((d.name, f"meta.json original_file missing or absent on disk: {original!r}"))
                continue
            docs.append(StagedDocument("generic", d, d / original))
    return docs, errors


def current_parse_is_fresh(doc: StagedDocument, text_source: str | None, text_sha: str | None) -> bool:
    out = doc.dir / "parsed.json"
    if not out.is_file():
        return False
    try:
        prev = json.loads(out.read_text())
    except json.JSONDecodeError:
        return False
    if prev.get("parser_version") != PARSER_VERSION:
        return False
    # A PDF's text never changes; an OCR'd photo's text can (a new ocr.corrected.txt, re-OCR),
    # and the provenance label must track which file was parsed even when the bytes agree.
    if prev.get("text_source") in ("ocr", "ocr_corrected"):
        return text_sha is not None and prev.get("text_sha256") == text_sha and prev.get("text_source") == text_source
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="parse everything, write nothing")
    ap.add_argument("--force", action="store_true", help="re-parse even when parsed.json is current")
    ap.add_argument("--lider-root", type=Path, default=LIDER_ROOT)
    ap.add_argument("--generic-root", type=Path, default=GENERIC_ROOT)
    args = ap.parse_args()

    docs, failed = staged_documents(args.lider_root, args.generic_root)
    if not docs and not failed:
        print(f"no staged receipts ({args.lider_root}, {args.generic_root})")
        return 0

    ok = 0
    skipped = 0
    for doc in docs:
        try:
            text: str | None = None
            text_source: str | None = None
            text_sha: str | None = None
            if doc.root == "generic" and doc.document.suffix.lower() != ".pdf":
                # OCR (cached) up front: the freshness check needs the text the parse would see.
                text, text_source = text_for_document(doc.dir, doc.document)
                text_sha = sha256_text(text)
            if not args.force and not args.check and current_parse_is_fresh(doc, text_source, text_sha):
                skipped += 1
                continue
            if text is None:
                text, text_source = text_for_document(doc.dir, doc.document)
                text_sha = sha256_text(text)
            parsed = parse_receipt_text(text)
        except ReceiptParseError as e:
            stale = doc.dir / "parsed.json"
            if stale.is_file() and not args.check:
                # The previous parse no longer describes the current text/parser: a stale
                # parsed.json must not be importable behind a failure (`--skip-parse`).
                stale.unlink()
                failed.append((doc.dir.name, f"{e} (stale parsed.json removed)"))
            else:
                failed.append((doc.dir.name, str(e)))
            continue
        if parsed.ignored_lines:
            print(f"  note {doc.dir.name}: ignored {len(parsed.ignored_lines)} digit-less line(s) in the item section: "
                  + " | ".join(repr(l) for l in parsed.ignored_lines[:4]))
        if not args.check:
            payload = asdict(parsed)
            payload["parser_version"] = PARSER_VERSION
            payload["text_source"] = text_source
            payload["text_sha256"] = text_sha
            (doc.dir / "parsed.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1))
        ok += 1

    print(f"parsed ok={ok} skipped={skipped} failed={len(failed)}")
    for name, err in failed:
        print(f"  FAIL {name}: {err}")
    return len(failed)


if __name__ == "__main__":
    sys.exit(main())
