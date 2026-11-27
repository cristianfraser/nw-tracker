#!/usr/bin/env python3
"""The shared cartola text reading against `server/contracts/data/cartolaTextCases.json`.

  python3 ingest/python/cartola_text_test.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from cartola_text import cartola_text

CASES = json.loads((SCRIPT_DIR.parent.parent / "server" / "contracts" / "data" / "cartolaTextCases.json").read_text(encoding="utf-8"))


def generated(p: dict) -> list:
    """The case file's generated strings (its LCG)."""
    alphabet = p["alphabet"]
    state = p["seed"]
    out = []
    for _ in range(p["count"]):
        s = ""
        for _ in range(p["length"]):
            state = (state * 1103515245 + 12345) % 2147483648
            s += alphabet[state % len(alphabet)]
        out.append(s)
    return out


class CartolaTextCasesTest(unittest.TestCase):
    def test_shared_cases(self) -> None:
        self.assertGreater(len(CASES["cases"]), 0)
        for c in CASES["cases"]:
            with self.subTest(c["why"]):
                self.assertEqual(cartola_text(c["raw"]), c["text"])
                self.assertEqual(cartola_text(c["text"]), c["text"])

    def test_idempotent_and_alike_on_both_sides(self) -> None:
        readings = [cartola_text(s) for s in generated(CASES["property"])]
        for r in readings:
            self.assertEqual(cartola_text(r), r)
        self.assertEqual(hashlib.sha256("\n".join(readings).encode("utf-8")).hexdigest(), CASES["property"]["sha256"])


if __name__ == "__main__":
    unittest.main()
