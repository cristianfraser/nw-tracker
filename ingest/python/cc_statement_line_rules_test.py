#!/usr/bin/env python3
"""Shared statement-line section table (synthetic data only).

The same table is asserted by `server/src/ccStatementLineRules.test.ts`.

  python3 ingest/python/cc_statement_line_rules_test.py
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[2] / "server" / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cc_statement_line_rules as rules  # noqa: E402

CASES_PATH = SCRIPT_DIR.parent.parent / "server" / "src" / "test" / "ccStatementLineSectionCases.json"


class SharedSectionCasesTest(unittest.TestCase):
    def test_every_case(self) -> None:
        cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        self.assertTrue(cases)
        for c in cases:
            with self.subTest(case=c):
                self.assertEqual(
                    rules.classify_statement_line(
                        c["currency"], c["merchant"], c["layout"], float(c["amount"])
                    ),
                    c["section"],
                )
                self.assertEqual(
                    rules.is_traspaso_deuda_merchant(c["merchant"]),
                    c.get("traspaso_deuda", False),
                )


if __name__ == "__main__":
    unittest.main()
