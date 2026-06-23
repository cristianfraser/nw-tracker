"""Tests for payroll liquidación OCR parsing (UNHOLSTER 2018 scans)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / ".pdf_deps"))

spec = importlib.util.spec_from_file_location(
    "parse_payroll_liquidaciones",
    SCRIPT_DIR / "parse-payroll-liquidaciones.py",
)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

CFRASER = SCRIPT_DIR.parent.parent / "cfraser"


def test_unholster_scan_april_2018_liquido():
    path = CFRASER / "liquidaciones/2018/2018-04.pdf"
    if not path.is_file():
        return
    parsed = mod.parse_payroll_pdf(path)
    assert parsed["format"] == "unholster_scan"
    assert parsed["liquido_clp"] == 304_804
    assert parsed["employer_name"].upper().startswith("UNHOLSTER")


def test_unholster_scan_september_2018_liquido():
    path = CFRASER / "liquidaciones/2018/2018-09.pdf"
    if not path.is_file():
        return
    parsed = mod.parse_payroll_pdf(path)
    assert parsed["format"] == "unholster_scan"
    assert parsed["liquido_clp"] == 1_271_796
