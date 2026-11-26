#!/usr/bin/env python3
"""Accepted statement parses and the parser audit — synthetic files only."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

_TMP = tempfile.TemporaryDirectory()
CACHE_DIR = Path(_TMP.name) / "cache"
os.environ["CC_PARSE_CACHE_DIR"] = str(CACHE_DIR)
# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[2] / "server" / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT = Path(__file__).resolve().parent / "parse-cc-statement-pdfs.py"
spec = importlib.util.spec_from_file_location("parse_cc_statement_pdfs_acceptance", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["parse_cc_statement_pdfs_acceptance"] = mod
spec.loader.exec_module(mod)

import cc_parse_acceptance as acceptance  # noqa: E402


def _payload(pdf: Path, lines: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "source_pdf": pdf.name,
        "card_group": "A",
        "effective_group": "A",
        "parser": "compact",
        "meta": {"statement_date": "20/01/2031", "card_last4": "0001"},
        "parsed": lines,
        "full": "synthetic text",
        "layout": "",
    }


LINE_A = {"merchant": "SYNTHETIC SHOP", "amount_clp": 1000, "fecha": "05/01/2031"}
LINE_B = {"merchant": "SYNTHETIC CAFE", "amount_clp": 2500, "fecha": "07/01/2031"}


class AcceptedParseTest(unittest.TestCase):
    def setUp(self) -> None:
        self._work = tempfile.TemporaryDirectory()
        self.pdfs = Path(self._work.name) / "statements"
        self.pdfs.mkdir()
        self.pdf = self.pdfs / "2031-01-20 estado de cuenta tarjeta 0001.pdf"
        self.pdf.write_bytes(os.urandom(32))
        self.csv = Path(self._work.name) / "parsed.csv"
        self.csv.write_text("rows of the run\n", encoding="utf-8")
        self.parses: List[Path] = []
        self._parse_one_pdf = mod.parse_one_pdf

    def tearDown(self) -> None:
        mod.parse_one_pdf = self._parse_one_pdf
        for name in ("accepted.json", "parse-manifest.json", "audit-state.json"):
            (CACHE_DIR / name).unlink(missing_ok=True)
        self._work.cleanup()

    def _current_parser_reads(self, lines: List[Dict[str, Any]]) -> None:
        def fake(card_group: str, pdf_path: Path, baseline: Any, *, cc_root: Any = None) -> Any:
            self.parses.append(pdf_path)
            p = _payload(pdf_path, lines)
            return [], {**p, "pdf_path": str(pdf_path)}

        mod.parse_one_pdf = fake

    def _accept_run(self, version: str, lines: List[Dict[str, Any]]) -> str:
        """One parser run at `version` followed by a successful import."""
        pdf_hash = mod.save_parse_cache(self.pdf, version, _payload(self.pdf, lines))
        acceptance.write_manifest(
            CACHE_DIR, self.csv, [{"pdf_sha256": pdf_hash, "parser_version": version, "source_pdf": self.pdf.name}]
        )
        acceptance.accept_manifest(CACHE_DIR)
        return pdf_hash

    def _audit(self, version: str, *, adopt: bool = False, if_stale: bool = False) -> int:
        return mod.run_parse_audit(
            [("A", self.pdf)], version, [], pdfs_dir=self.pdfs, adopt=adopt, if_stale=if_stale
        )

    def test_a_parse_not_yet_accepted_is_read_again_by_a_new_parser(self) -> None:
        mod.save_parse_cache(self.pdf, "v1", _payload(self.pdf, [LINE_A]))
        accepted = acceptance.load_accepted(CACHE_DIR)
        self.assertIsNotNone(mod.load_parse_cache(self.pdf, "v1", accepted))
        self.assertIsNone(mod.load_parse_cache(self.pdf, "v2", accepted))

    def test_an_accepted_parse_is_kept_by_a_new_parser(self) -> None:
        self._accept_run("v1", [LINE_A])
        kept = mod.load_parse_cache(self.pdf, "v2", acceptance.load_accepted(CACHE_DIR))
        assert kept is not None
        self.assertEqual(kept["parser_version"], "v1")
        self.assertEqual(kept["parsed"], [LINE_A])

    def test_acceptance_names_the_version_it_accepted(self) -> None:
        self._accept_run("v1", [LINE_A])
        # The entry is read again by v2 and that reading was never imported.
        mod.save_parse_cache(self.pdf, "v2", _payload(self.pdf, [LINE_A, LINE_B]))
        self.assertIsNone(mod.load_parse_cache(self.pdf, "v3", acceptance.load_accepted(CACHE_DIR)))

    def test_nothing_is_accepted_when_the_csv_changed_after_the_run(self) -> None:
        pdf_hash = mod.save_parse_cache(self.pdf, "v1", _payload(self.pdf, [LINE_A]))
        acceptance.write_manifest(
            CACHE_DIR, self.csv, [{"pdf_sha256": pdf_hash, "parser_version": "v1", "source_pdf": self.pdf.name}]
        )
        self.csv.write_text("another run's rows\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            acceptance.accept_manifest(CACHE_DIR)
        self.assertEqual(acceptance.load_accepted(CACHE_DIR), {})

    def test_audit_moves_an_identical_reading_to_the_current_version(self) -> None:
        pdf_hash = self._accept_run("v1", [LINE_A])
        self._current_parser_reads([LINE_A])
        self.assertEqual(self._audit("v2"), 0)
        accepted = acceptance.load_accepted(CACHE_DIR)
        self.assertEqual(accepted[pdf_hash]["parser_version"], "v2")
        entry = mod.load_parse_cache(self.pdf, "v2", accepted)
        assert entry is not None
        self.assertEqual(entry["parser_version"], "v2")
        # Nothing stale is left: a second audit parses nothing.
        self.assertEqual(self._audit("v2"), 0)
        self.assertEqual(len(self.parses), 1)

    def test_audit_reports_a_different_reading_and_leaves_the_accepted_one(self) -> None:
        pdf_hash = self._accept_run("v1", [LINE_A])
        self._current_parser_reads([LINE_A, LINE_B])
        self.assertEqual(self._audit("v2"), 1)
        accepted = acceptance.load_accepted(CACHE_DIR)
        self.assertEqual(accepted[pdf_hash]["parser_version"], "v1")
        kept = mod.load_parse_cache(self.pdf, "v2", accepted)
        assert kept is not None
        self.assertEqual(kept["parsed"], [LINE_A])
        state = json.loads(acceptance.audit_state_path(CACHE_DIR).read_text(encoding="utf-8"))
        self.assertEqual(state["parser_version"], "v2")
        self.assertEqual(state["differences"][0]["source_pdf"], self.pdf.name)
        self.assertEqual(state["differences"][0]["changes"], ["lines: 1 → 2 (0 no longer read, 1 new or changed)"])

    def test_the_nightly_audit_reports_a_parser_version_once(self) -> None:
        self._accept_run("v1", [LINE_A])
        self._current_parser_reads([LINE_A, LINE_B])
        self.assertEqual(self._audit("v2", if_stale=True), 1)
        self.assertEqual(self._audit("v2", if_stale=True), 0)
        self.assertEqual(len(self.parses), 1)
        # A newer parser is audited again.
        self.assertEqual(self._audit("v3", if_stale=True), 1)
        self.assertEqual(len(self.parses), 2)

    def test_adopt_takes_the_reported_reading_without_parsing_again(self) -> None:
        pdf_hash = self._accept_run("v1", [LINE_A])
        self._current_parser_reads([LINE_A, LINE_B])
        self.assertEqual(self._audit("v2"), 1)
        self.assertEqual(self._audit("v2", adopt=True), 0)
        self.assertEqual(len(self.parses), 1)
        accepted = acceptance.load_accepted(CACHE_DIR)
        self.assertNotIn(pdf_hash, accepted)
        taken = mod.load_parse_cache(self.pdf, "v2", accepted)
        assert taken is not None
        self.assertEqual(taken["parsed"], [LINE_A, LINE_B])
        self.assertFalse(acceptance.audit_state_path(CACHE_DIR).exists())

    def test_audit_fails_on_a_statement_the_current_parser_cannot_read(self) -> None:
        pdf_hash = self._accept_run("v1", [LINE_A])

        def boom(*_a: Any, **_k: Any) -> Any:
            raise ValueError("no readable text")

        mod.parse_one_pdf = boom
        self.assertEqual(self._audit("v2"), 1)
        self.assertEqual(acceptance.load_accepted(CACHE_DIR)[pdf_hash]["parser_version"], "v1")


class BootstrapTest(unittest.TestCase):
    def test_bootstrap_accepts_each_entry_at_its_own_version_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            per_pdf = acceptance.per_pdf_dir(cache)
            per_pdf.mkdir()
            for pdf_hash, version in (("a" * 64, "v1"), ("b" * 64, "v2")):
                (per_pdf / f"{pdf_hash}.json").write_text(
                    json.dumps({"pdf_sha256": pdf_hash, "parser_version": version, "source_pdf": "x.pdf"}),
                    encoding="utf-8",
                )
            self.assertEqual(acceptance.bootstrap_accept_cache(cache), 2)
            accepted = acceptance.load_accepted(cache)
            self.assertEqual(accepted["a" * 64]["parser_version"], "v1")
            self.assertEqual(accepted["b" * 64]["parser_version"], "v2")
            with self.assertRaises(RuntimeError):
                acceptance.bootstrap_accept_cache(cache)


class DescribeDifferenceTest(unittest.TestCase):
    def test_header_and_text_changes_are_named(self) -> None:
        pdf = Path("s.pdf")
        old = _payload(pdf, [LINE_A])
        new = _payload(pdf, [LINE_A])
        new["meta"] = {**new["meta"], "statement_date": "21/01/2031"}
        new["full"] = "synthetic text, longer"
        self.assertEqual(
            acceptance.describe_parse_difference(old, new),
            ["header: statement_date: '20/01/2031' → '21/01/2031'", "full text: 14 → 22 characters"],
        )
        self.assertEqual(acceptance.describe_parse_difference(old, _payload(pdf, [LINE_A])), [])
        # The same bytes filed under another name are the same reading.
        self.assertEqual(acceptance.describe_parse_difference(old, _payload(Path("copy.pdf"), [LINE_A])), [])


if __name__ == "__main__":
    unittest.main()
