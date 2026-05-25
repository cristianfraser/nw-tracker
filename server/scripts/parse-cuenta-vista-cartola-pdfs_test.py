#!/usr/bin/env python3
"""Smoke test for cuenta vista cartola PDF parser."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "parse-cuenta-vista-cartola-pdfs.py"
spec = importlib.util.spec_from_file_location("parse_cv", SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules["parse_cv"] = mod
spec.loader.exec_module(mod)

PDF = (
    Path(__file__).resolve().parents[2]
    / "cfraser/cartolas-cuenta-vista/2024-10-30 cartola cuenta vista 65.pdf"
)


def test_oct_2024_cartola():
    if not PDF.is_file():
        return
    parsed = mod.parse_cartola_pdf(PDF)
    assert parsed.parse_status == "ok", parsed.parse_error
    assert parsed.period_month == "2024-10"
    assert len(parsed.movements) == 5
    dap_return = next(m for m in parsed.movements if m.document_no == "9204418")
    assert dap_return.amount_clp == 4_160_842
    assert dap_return.occurred_on == "2024-10-04"


if __name__ == "__main__":
    test_oct_2024_cartola()
    print("ok")
