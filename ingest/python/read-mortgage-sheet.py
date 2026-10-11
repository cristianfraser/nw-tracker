#!/usr/bin/env python3
"""Read the mortgage sheet out of the personal Numbers file and write its payment rows as JSON.

  PYTHONPATH=python/.numbers_deps python3 python/read-mortgage-sheet.py \
      --file=<cfraser.numbers> --sheet=depto --table=dividendos --out=<rows.json>

Reads the table in place (no export step) with numbers-parser, which tells typed cells from
formulas — that is what decides which cuota rows are posted (see mortgage_sheet.py). Output:
{document: {path, name, sha256, size, modified_at}, sheet, table, rows, projected}. Any row the
module cannot account for fails the read; nothing is guessed.

  mkdir -p ingest/python/.numbers_deps
  pip3 install numbers-parser -t ingest/python/.numbers_deps
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import sys
import warnings
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEPS = SCRIPT_DIR / ".numbers_deps"
if DEPS.is_dir() and str(DEPS) not in sys.path:
    sys.path.insert(0, str(DEPS))
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from mortgage_sheet import COL, POSTED_CELLS, MortgageSheetError, cell, payment_rows  # noqa: E402

# Rendering a formula's text is slow (numbers-parser walks the formula AST per cell), and only the
# posted cells need it (a bare-number formula counts as typed); every other cell needs just the flag.
FORMULA_TEXT_COLS = frozenset(COL[k] for k in POSTED_CELLS)


def load_grid(path: Path, sheet_name: str, table_name: str) -> list[list[dict]]:
    try:
        from numbers_parser import Document
    except ImportError as e:  # pragma: no cover - environment
        raise SystemExit(f"numbers-parser is not installed under {DEPS}: {e}\n  pip3 install numbers-parser -t {DEPS}")
    doc = Document(str(path))
    sheets = [s for s in doc.sheets if s.name == sheet_name]
    if len(sheets) != 1:
        raise SystemExit(f"sheet {sheet_name!r} not found in {path.name} (sheets: {[s.name for s in doc.sheets]})")
    tables = [t for t in sheets[0].tables if t.name == table_name]
    if len(tables) != 1:
        raise SystemExit(f"table {table_name!r} not found in sheet {sheet_name!r} (tables: {[t.name for t in sheets[0].tables]})")
    grid: list[list[dict]] = []
    with warnings.catch_warnings():
        # numbers-parser warns on formulas it cannot render; a formula is a formula either way.
        warnings.simplefilter("ignore")
        for row in tables[0].rows():
            out: list[dict] = []
            for c in row:
                is_formula = bool(getattr(c, "is_formula", False))
                formula = None
                if is_formula and c.col in FORMULA_TEXT_COLS:
                    try:
                        formula = c.formula
                    except Exception:
                        formula = None
                out.append(cell(c.value, is_formula, formula))
            grid.append(out)
    return grid


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--table", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    path = Path(a.file).expanduser()
    if not path.exists():
        raise SystemExit(f"not found: {path}")
    data = path.read_bytes()
    try:
        result = payment_rows(load_grid(path, a.sheet, a.table))
    except MortgageSheetError as e:
        raise SystemExit(f"mortgage sheet: {e}")
    st = path.stat()
    out = {
        "document": {
            "path": str(path),
            "name": path.name,
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": st.st_size,
            "modified_at": _dt.datetime.fromtimestamp(st.st_mtime, tz=_dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        },
        "sheet": a.sheet,
        "table": a.table,
        "rows": result["rows"],
        "projected": result["projected"],
    }
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"mortgage sheet: {len(out['rows'])} payment row(s), {len(out['projected'])} projected cuota(s) left out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
