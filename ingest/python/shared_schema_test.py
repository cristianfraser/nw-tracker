#!/usr/bin/env python3
"""Each parser's JSON output, the cc-cards config and the line rules validate against the shared
schemas in `server/contracts/data/schemas/` — synthetic inputs only.

  python3 ingest/python/shared_schema_test.py
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import sys
import unittest
from dataclasses import asdict
from pathlib import Path

# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[2] / "server" / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / ".pdf_deps"))

import shared_schema  # noqa: E402
from shared_schema import SchemaError, load_schema, validate  # noqa: E402


def load_script(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class ValidatorTest(unittest.TestCase):
    def test_reports_type_required_extra_and_pattern(self) -> None:
        schema = {
            "type": "object",
            "properties": {"a": {"type": "integer"}, "b": {"type": "string", "pattern": "^x"}},
            "required": ["a"],
            "additionalProperties": False,
        }
        validate({"a": 1, "b": "xy"}, schema)
        for bad in ({"b": "xy"}, {"a": "1"}, {"a": True}, {"a": 1, "b": "y"}, {"a": 1, "c": 0}):
            with self.assertRaises(SchemaError):
                validate(bad, schema)

    def test_unknown_keyword_is_an_error(self) -> None:
        with self.assertRaises(SchemaError):
            validate(1, {"oneOf": [{"type": "integer"}]})


class ConfigFilesTest(unittest.TestCase):
    def test_cc_cards_fixture_and_unknown_key(self) -> None:
        schema = load_schema("cc-cards")
        validate(json.loads(Path(os.environ["NW_TRACKER_CC_CARDS"]).read_text(encoding="utf-8")), schema)
        with self.assertRaises(SchemaError):
            validate({"not_a_key": []}, schema)

    def test_line_rules_file_and_the_parser_key_list(self) -> None:
        import cc_statement_line_rules

        schema = load_schema("cc-statement-line-rules")
        validate(json.loads(cc_statement_line_rules.RULES_PATH.read_text(encoding="utf-8")), schema)
        # The parser's loader keeps its own key list (editing it re-parses the corpus); it must be the schema's.
        self.assertEqual(sorted(cc_statement_line_rules._KEYS), sorted(schema["required"]))

    def test_card_parser_csv_columns(self) -> None:
        parser = load_script("parse_cc_statement_pdfs_schema", "parse-cc-statement-pdfs.py")
        self.assertEqual(parser.CSV_COLUMNS, shared_schema.card_parsed_statement_columns())


class ParserOutputsTest(unittest.TestCase):
    def test_payroll_index(self) -> None:
        payroll = load_script("parse_payroll_schema", "parse-payroll-liquidaciones.py")
        text = "\n".join(
            [
                "FINIQUITO LABORAL",
                "Empleador(a): Empresa Sintetica SpA RUT: 76.000.000-0",
                "Con fecha 30/04/2036 se pone término al contrato.",
                "PAGOS:",
                "  - Feriado proporcional $ 1.000.000",
                "  - Indemnización por años de servicio $ 0",
                "TOTAL PAGOS BRUTOS: $ 1.000.000",
                "DESCUENTOS:",
                "  - Impuesto único $ 50.000",
                "TOTAL DESCUENTOS: $ 50.000",
                "SUBTOTAL LÍQUIDO: $ 950.000",
                "REAJUSTES E INTERESES: $ 0",
                "SUMA LÍQUIDA A PAGAR: $ 950.000",
            ]
        )
        payroll.extract_payroll_pdf_text = lambda _path: text
        row = payroll.parse_payroll_pdf(Path("/synthetic/2036-04-finiquito.pdf"))
        index = {"parser_version": "test", "count": 1, "failures": [], "rows": [row]}
        validate(json.loads(json.dumps(index)), load_schema("parsed-payroll-index"))

    def test_cartola_pdf_files(self) -> None:
        schema = load_schema("parsed-cartola-pdf-file")
        vista = load_script("parse_cv_schema", "parse-cuenta-vista-cartola-pdfs.py")
        vista_fixture = load_script("parse_cv_test_schema", "parse-cuenta-vista-cartola-pdfs_test.py")
        parsed = vista.parse_cartola_text(vista_fixture.synthetic_annual_cartola(), "sintetica.pdf")
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        validate(json.loads(json.dumps({"generated_at": "2036-01-01", "pdfs_dir": "/x", "cartolas": [asdict(parsed)]})), schema)

        checking = load_script("parse_cc_cartola_schema", "parse-checking-cartola-pdfs.py")
        cartola = checking.ParsedCartola(
            source_file="sintetica.pdf",
            period_month="2036-01",
            period_from="2036-01-01",
            period_to="2036-01-31",
            saldo_inicial_clp=1_000,
            saldo_final_clp=1_500,
            movements=[checking.Movement(occurred_on="2036-01-10", amount_clp=500, branch="0001", description="Abono")],
            extractor="pdftotext-layout",
        )
        validate(
            json.loads(json.dumps({"generated_at": "2036-01-01T00:00:00Z", "pdfs_dir": "/x", "cartolas": [checking.cartola_to_dict(cartola)]})),
            schema,
        )

    def test_grocery_parsed_json(self) -> None:
        from grocery_receipt_parse import parse_receipt_text
        import grocery_receipt_parse_test as fixtures

        grocery = load_script("parse_grocery_schema", "parse-grocery-receipts.py")
        schema = load_schema("parsed-grocery-receipt")
        for text in (fixtures.STORE_PDF_TEXT, fixtures.JUMBO_TEXT):
            payload = asdict(parse_receipt_text(text))
            payload["parser_version"] = grocery.PARSER_VERSION
            payload["text_source"] = "pdftotext"
            payload["text_sha256"] = "0" * 64
            validate(json.loads(json.dumps(payload)), schema)


if __name__ == "__main__":
    unittest.main()
