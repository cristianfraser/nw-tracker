#!/usr/bin/env python3
"""Unit tests for CC PDF readability / qpdf helpers."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "cc_pdf_qpdf.py"
spec = importlib.util.spec_from_file_location("cc_pdf_qpdf", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cc_pdf_qpdf"] = mod
spec.loader.exec_module(mod)


class ReadableTextTest(unittest.TestCase):
    def test_clp_statement_marker(self) -> None:
        self.assertTrue(
            mod.is_readable_cc_statement_text(
                "ESTADO DE CUENTA EN MONEDA NACIONAL DE TARJETA DE CRÉDITO\n"
                "FECHA ESTADO DE CUENTA\n23/03/2021\n"
            )
        )

    def test_intl_marker(self) -> None:
        self.assertTrue(
            mod.is_readable_cc_statement_text(
                "ESTADO DE CUENTA INTERNACIONAL\nMONTO US$\n"
            )
        )

    def test_garbled_not_readable(self) -> None:
        self.assertFalse(mod.is_readable_cc_statement_text('\t\x15\x16"#$&\n'))

    def test_too_short_not_readable(self) -> None:
        self.assertFalse(mod.is_readable_cc_statement_text("hello"))


if __name__ == "__main__":
    unittest.main()
