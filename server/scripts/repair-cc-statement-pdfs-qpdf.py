#!/usr/bin/env python3
"""
Run qpdf on unreadable credit-card statement PDFs under cfraser/.

Usage (repo root):
  npm run repair:cc-pdfs-qpdf
  python3 server/scripts/repair-cc-statement-pdfs-qpdf.py [--dir=...] [--dry-run]

Also runs automatically before parse in `import:cfraser-inbox` (skip with --skip-qpdf-repair).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from cc_pdf_qpdf import (  # noqa: E402
    is_readable_cc_statement_text,
    load_repo_dotenv,
    pdf_is_encrypted,
    peek_pdf_text,
    qpdf_available,
    repair_unreadable_pdfs_in_dir,
    statement_pdf_password,
)

DEFAULT_DIR = REPO_ROOT / "cfraser" / "credit-card-statements"
INBOX_DIR = REPO_ROOT / "cfraser" / "pdfs"


def main() -> int:
    load_repo_dotenv()
    parser = argparse.ArgumentParser(description="qpdf repair for unreadable CC statement PDFs")
    parser.add_argument(
        "--dir",
        default=os.environ.get("CFRASER_PDFS_DIR", str(DEFAULT_DIR)),
        help="PDF directory (default: credit-card-statements)",
    )
    parser.add_argument(
        "--inbox",
        action="store_true",
        help="Also scan cfraser/pdfs/ for Santander 80_* downloads",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not qpdf_available():
        print("# ERROR: qpdf not found. Install with: brew install qpdf", file=sys.stderr)
        return 1

    dirs = [Path(args.dir)]
    if args.inbox:
        dirs.append(INBOX_DIR)

    exit_code = 0
    for directory in dirs:
        if not directory.is_dir():
            print(f"# skip (not a directory): {directory}")
            continue
        print(f"# repair-cc-pdfs-qpdf: {directory}")
        if args.dry_run:
            for path in sorted(directory.rglob("*.pdf")):
                if "unreadable" in path.parts:
                    continue
                if path.stem.endswith("-CORRUPT"):
                    continue
                text = peek_pdf_text(path)
                if is_readable_cc_statement_text(text):
                    continue
                enc = "encrypted" if pdf_is_encrypted(path) else "not encrypted"
                print(f"# would repair\t{path.name}\t(unreadable, {enc})")
            continue

        notes = repair_unreadable_pdfs_in_dir(directory, password=statement_pdf_password())
        for name, note in notes:
            print(f"# qpdf\t{name}\t{note}")
            if "still unreadable" in note or "repair failed" in note:
                exit_code = 1

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
