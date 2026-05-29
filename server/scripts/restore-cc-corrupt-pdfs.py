#!/usr/bin/env python3
"""
Restore PDFs falsely renamed to `-CORRUPT.pdf` after a parse cache bug, or relocate
genuinely unreadable files to `credit-card-statements/unreadable/`.

  python3 server/scripts/restore-cc-corrupt-pdfs.py
  python3 server/scripts/restore-cc-corrupt-pdfs.py --dry-run
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from cc_pdf_qpdf import is_readable_cc_statement_text, load_repo_dotenv, peek_pdf_text
from cc_statement_pdf_paths import UNREADABLE_DIR

REPO_ROOT = Path(__file__).resolve().parents[2]
CFRASER_DIR = REPO_ROOT / "cfraser"

CORRUPT_SUFFIX = "-CORRUPT"


def normal_name_from_corrupt(filename: str) -> str:
    if filename.lower().endswith("-corrupt.pdf"):
        return f"{filename[: -len('-CORRUPT.pdf')]}.pdf"
    return filename


def restore_corrupt_pdfs(
    statements_dir: Path,
    *,
    dry_run: bool = False,
) -> tuple[int, int, int]:
    """Returns (restored, moved_unreadable, skipped)."""
    restored = 0
    moved_unreadable = 0
    skipped = 0
    unreadable_root = statements_dir / UNREADABLE_DIR
    if not dry_run:
        unreadable_root.mkdir(exist_ok=True)

    corrupt_files = sorted(statements_dir.rglob(f"*{CORRUPT_SUFFIX}.pdf"))
    for src in corrupt_files:
        if UNREADABLE_DIR in src.parts:
            continue
        good_name = normal_name_from_corrupt(src.name)
        dest = src.parent / good_name
        text = peek_pdf_text(src)
        readable = is_readable_cc_statement_text(text)
        if readable:
            if dest.exists():
                print(f"# skip restore (target exists): {good_name}")
                skipped += 1
                continue
            print(f"# restore {src.name} -> {good_name}")
            if not dry_run:
                src.rename(dest)
            restored += 1
        else:
            unreadable_dest = unreadable_root / good_name
            print(f"# unreadable {src.name} -> {UNREADABLE_DIR}/{good_name}")
            if not dry_run:
                if unreadable_dest.exists():
                    src.unlink()
                else:
                    src.rename(unreadable_dest)
            moved_unreadable += 1

    # Flatten any legacy -CORRUPT files already under unreadable/
    if unreadable_root.is_dir():
        for src in sorted(unreadable_root.glob(f"*{CORRUPT_SUFFIX}.pdf")):
            good_name = normal_name_from_corrupt(src.name)
            dest = unreadable_root / good_name
            if dest.exists():
                if not dry_run and src.exists():
                    src.unlink()
                continue
            print(f"# rename in unreadable/ {src.name} -> {good_name}")
            if not dry_run:
                src.rename(dest)
            skipped += 1

    return restored, moved_unreadable, skipped


def main() -> int:
    load_repo_dotenv()
    parser = argparse.ArgumentParser(description="Restore false -CORRUPT CC statement PDF renames")
    parser.add_argument(
        "--dir",
        type=Path,
        default=CFRASER_DIR / "credit-card-statements",
        help="credit-card-statements directory",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    statements_dir: Path = args.dir
    if not statements_dir.is_dir():
        print(f"# missing directory: {statements_dir}", file=sys.stderr)
        return 1
    restored, moved, skipped = restore_corrupt_pdfs(statements_dir, dry_run=args.dry_run)
    print(
        f"# restore-cc-corrupt-pdfs: restored={restored} "
        f"moved_unreadable={moved} skipped={skipped}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
