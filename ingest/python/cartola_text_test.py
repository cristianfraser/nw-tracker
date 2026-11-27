#!/usr/bin/env python3
"""The shared cartola text reading against `server/contracts/data/cartolaTextCases.json`.

  python3 ingest/python/cartola_text_test.py
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from cartola_text import cartola_text

CASES_PATH = SCRIPT_DIR.parent.parent / "server" / "contracts" / "data" / "cartolaTextCases.json"


class CartolaTextCasesTest(unittest.TestCase):
    def test_shared_cases(self) -> None:
        cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 0)
        for c in cases:
            with self.subTest(c["why"]):
                self.assertEqual(cartola_text(c["raw"]), c["text"])
                self.assertEqual(cartola_text(c["text"]), c["text"])


if __name__ == "__main__":
    unittest.main()
