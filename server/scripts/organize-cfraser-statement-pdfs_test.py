#!/usr/bin/env python3
"""Tests for Santander 80_* PDF filename date fallback."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "organize-cfraser-statement-pdfs.py"
spec = importlib.util.spec_from_file_location("organize_pdfs", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["organize_pdfs"] = mod
spec.loader.exec_module(mod)


class Santander80FilenameTest(unittest.TestCase):
    def test_iso_from_filename(self) -> None:
        self.assertEqual(
            mod.iso_from_santander_80_filename(
                "80_356524_REDACTED_20201124.pdf"
            ),
            "2020-11-24",
        )
        self.assertEqual(
            mod.iso_from_santander_80_filename(
                "80_377457_REDACTED_20210222.pdf"
            ),
            "2021-02-22",
        )
        self.assertIsNone(mod.iso_from_santander_80_filename("cartola-65.pdf"))

    def test_infer_usd_as_smaller_peer(self) -> None:
        root = Path(__file__).resolve().parent.parent / "cfraser" / "pdfs"
        a = root / "80_356524_REDACTED_20201124.pdf"
        b = root / "80_356525_REDACTED_20201124.pdf"
        if not a.is_file() or not b.is_file():
            self.skipTest("fixture PDFs missing")
        groups = mod.build_santander_80_iso_groups([a, b])
        self.assertEqual(len(groups["2020-11-24"]), 2)
        flags = mod.build_intl_flags_for_santander_80_pairs(groups)
        smaller = a if a.stat().st_size < b.stat().st_size else b
        larger = b if smaller is a else a
        self.assertTrue(flags[smaller.resolve()])
        self.assertFalse(flags[larger.resolve()])

    def test_cc_suffix_maps_account_to_4141(self) -> None:
        self.assertEqual(
            mod.cc_suffix(
                "80_356524_REDACTED_20201124.pdf",
                None,
                None,
            ),
            "4141",
        )


if __name__ == "__main__":
    unittest.main()
