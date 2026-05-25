#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Re-run CC statement parse reconciliation against CSV rows and PDFs.

Reads cfraser/cc-statements-parsed-all.csv, groups by source_pdf, re-reads each PDF
from CFRASER_PDFS_DIR (default cfraser/credit-card-statements), and compares parsed
line sums to PDF section totals.

Exit 1 if any non-skipped statement fails (same semantics as parse-cc-statement-pdfs).

Usage (repo root):
  npm run check:cc-parse
"""
from __future__ import annotations

import csv
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
CFRASER_DIR = REPO_ROOT / "cfraser"
DEFAULT_CSV = CFRASER_DIR / "cc-statements-parsed-all.csv"
DEFAULT_JSONL = CFRASER_DIR / "cc-statements-parse-reconciliation.jsonl"

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import importlib.util

spec = importlib.util.spec_from_file_location(
    "parse_cc_pdfs", SCRIPT_DIR / "parse-cc-statement-pdfs.py"
)
parse_mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(parse_mod)

from cc_statement_reconcile import (  # noqa: E402
    reconcile_statement,
    reconcile_statement_required,
    write_reconciliation_jsonl,
)

_SKIP_REASONS = frozenset({"zero_rows", "incomplete_parse", "excluded_pdf"})


def load_csv_rows(path: Path) -> List[Dict[str, Any]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def main() -> int:
    csv_path = Path(os.environ.get("CC_PARSE_OUTPUT_CSV", str(DEFAULT_CSV)))
    pdfs_dir = Path(
        os.environ.get("CFRASER_PDFS_DIR", str(CFRASER_DIR / "credit-card-statements"))
    )
    jsonl_path = Path(
        os.environ.get(
            "CC_RECONCILE_JSONL",
            str(DEFAULT_JSONL),
        )
    )

    if not csv_path.is_file():
        print(f"Missing CSV: {csv_path}", file=sys.stderr)
        return 1

    rows = load_csv_rows(csv_path)
    by_pdf: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_pdf[str(r.get("source_pdf") or "")].append(r)

    results = []
    fail_count = 0
    missing_pdf = 0

    for pdf_name in sorted(by_pdf.keys()):
        if not pdf_name:
            continue
        pdf_path = pdfs_dir / pdf_name
        stmt_rows = by_pdf[pdf_name]
        if not pdf_path.is_file():
            print(f"# MISSING_PDF\t{pdf_name}")
            missing_pdf += 1
            continue
        parser = parse_mod.choose_parser(pdf_path)
        try:
            _pages, full = parse_mod.extract_pdf_text(pdf_path, parser)
        except Exception as e:
            print(f"# READ_ERROR\t{pdf_name}\t{e}")
            missing_pdf += 1
            continue
        layout_text = ""
        if parser == "international_usd":
            meta = parse_mod.extract_meta_international(full, pdf_name)
            try:
                import subprocess

                layout_run = subprocess.run(
                    ["pdftotext", "-layout", str(pdf_path), "-"],
                    capture_output=True,
                    text=True,
                )
                if layout_run.returncode == 0:
                    layout_text = layout_run.stdout
            except (FileNotFoundError, OSError):
                layout_text = ""
        else:
            meta = parse_mod.extract_meta(full, pdf_name)
        result = reconcile_statement(
            pdf_name,
            meta,
            stmt_rows,
            full,
            parse_mod.parse_clp_amount,
            parse_mod.parse_usd_amount,
            layout_text=layout_text,
        )
        results.append(result)
        if (
            reconcile_statement_required(pdf_name, full_text)
            and result.skip_reason not in _SKIP_REASONS
            and not result.ok
        ):
            fail_count += 1

    write_reconciliation_jsonl(jsonl_path, results)

    ok_n = sum(1 for r in results if r.ok or r.skip_reason == "zero_rows")
    print(f"# CHECK_RECONCILE ok={ok_n} fail={fail_count} total={len(results)} missing_pdf={missing_pdf}")
    for r in results:
        if r.skip_reason == "zero_rows":
            continue
        if not r.ok:
            print(f"# RECONCILE_FAIL\t{r.source_pdf}\t{','.join(r.issue_codes)}")
            for ch in r.checks:
                if not ch.ok:
                    print(
                        f"#   {ch.code}: expected={ch.expected} actual={ch.actual} delta={ch.delta}"
                    )

    if jsonl_path.is_file():
        print(f"# wrote {jsonl_path}")

    return 1 if fail_count > 0 or missing_pdf > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
