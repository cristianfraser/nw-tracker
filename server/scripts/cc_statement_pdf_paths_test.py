#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "cc_statement_pdf_paths.py"
spec = importlib.util.spec_from_file_location("cc_paths", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cc_paths"] = mod
spec.loader.exec_module(mod)


class CcStatementPdfPathsTest(unittest.TestCase):
    def test_parse_organized_stem(self) -> None:
        clp = mod.parse_organized_cc_stem("2026-03-26 estado de cuenta tarjeta 4141")
        self.assertIsNotNone(clp)
        assert clp is not None
        self.assertEqual(clp["card_key"], "4141")
        self.assertFalse(clp["usd"])

        usd = mod.parse_organized_cc_stem(
            "2026-03-26 estado de cuenta tarjeta usd 4141"
        )
        self.assertIsNotNone(usd)
        assert usd is not None
        self.assertEqual(usd["card_key"], "4141")
        self.assertTrue(usd["usd"])

    def test_strip_numbered_copy(self) -> None:
        self.assertEqual(
            mod.strip_numbered_copy_suffix("2026-01-26 estado de cuenta tarjeta 4343 (2).pdf"),
            "2026-01-26 estado de cuenta tarjeta 4343.pdf",
        )

    def test_dest_path_layout(self) -> None:
        root = Path("/tmp/cc-test-root")
        dest = mod.cc_dest_path(
            root, "4141", True, "2026-03-26 estado de cuenta tarjeta usd 4141"
        )
        self.assertEqual(
            dest,
            root / "4141" / "usd" / "2026-03-26 estado de cuenta tarjeta usd 4141.pdf",
        )

    def test_dest_path_predecessor_card_uses_successor_folder(self) -> None:
        root = Path("/tmp/cc-test-root")
        dest = mod.cc_dest_path(
            root, "4114", True, "2018-02-22 estado de cuenta tarjeta usd 4114"
        )
        self.assertEqual(
            dest,
            root / "4141" / "usd" / "2018-02-22 estado de cuenta tarjeta usd 4114.pdf",
        )


if __name__ == "__main__":
    unittest.main()
