#!/usr/bin/env python3
"""Tests for the shared date / peso-amount parsers (synthetic values only).

  python3 server/scripts/statement_values_test.py
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from statement_values import (  # noqa: E402
    iso_date_from_parts,
    parse_clp_amount,
    parse_dd_mm_yy_to_iso,
    repair_jammed_year,
)

DATE_CASES_PATH = SCRIPT_DIR.parent / "src" / "test" / "ddMmYyToIsoCases.json"


class SharedDateCasesTest(unittest.TestCase):
    """The table `server/src/ddMmYyToIsoCases.test.ts` asserts against `parseDdMmYyToIso`."""

    def test_every_case(self) -> None:
        cases = json.loads(DATE_CASES_PATH.read_text(encoding="utf-8"))
        self.assertTrue(cases)
        for c in cases:
            with self.subTest(raw=c["raw"]):
                self.assertEqual(parse_dd_mm_yy_to_iso(c["raw"]), c["expect"])


class DateHelpersTest(unittest.TestCase):
    def test_repair_keeps_plausible_years_and_other_text(self) -> None:
        self.assertEqual(repair_jammed_year("22/10/2024"), "22/10/2024")
        self.assertEqual(repair_jammed_year("13/05/2511"), "13/05/25")
        self.assertEqual(repair_jammed_year(" 13/05/25 "), "13/05/25")
        self.assertEqual(repair_jammed_year("MONTO"), "MONTO")

    def test_iso_from_parts_is_range_checked(self) -> None:
        self.assertEqual(iso_date_from_parts(5, 3, 2026), "2026-03-05")
        self.assertIsNone(iso_date_from_parts(0, 3, 2026))
        self.assertIsNone(iso_date_from_parts(5, 13, 2026))


class ParseClpAmountTest(unittest.TestCase):
    def test_chilean_thousands(self) -> None:
        self.assertEqual(parse_clp_amount("1.234.567"), 1234567)
        self.assertEqual(parse_clp_amount("12.990"), 12990)
        self.assertEqual(parse_clp_amount("800"), 800)
        self.assertEqual(parse_clp_amount("0"), 0)

    def test_sign_currency_and_whitespace(self) -> None:
        self.assertEqual(parse_clp_amount("-50.000"), -50000)
        self.assertEqual(parse_clp_amount("$ 1.234"), 1234)
        self.assertEqual(parse_clp_amount("$ -1.234"), -1234)
        self.assertEqual(parse_clp_amount(" 1 600 "), 1600)

    def test_zero_decimals(self) -> None:
        self.assertEqual(parse_clp_amount("12.990,00"), 12990)
        self.assertEqual(parse_clp_amount("650,00"), 650)
        self.assertEqual(parse_clp_amount("0,00"), 0)

    def test_a_decimal_part_rounds_to_the_nearest_peso_ties_to_even(self) -> None:
        self.assertEqual(parse_clp_amount("39,99"), 40)
        self.assertEqual(parse_clp_amount("39,49"), 39)
        self.assertEqual(parse_clp_amount("10,50"), 10)
        self.assertEqual(parse_clp_amount("11,50"), 12)
        self.assertEqual(parse_clp_amount("-4,41"), -4)
        self.assertEqual(parse_clp_amount("1.234,5"), 1234)

    def test_malformed_text_is_none(self) -> None:
        for raw in ("", ".", "-", "$", "12.34", "1.2345", "1.234.5", "1,2,3", "12,", ",50", "abc", None):
            with self.subTest(raw=raw):
                self.assertIsNone(parse_clp_amount(raw))


if __name__ == "__main__":
    unittest.main()
