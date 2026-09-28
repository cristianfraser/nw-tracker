#!/usr/bin/env python3
"""International (USD) statement row parsing — synthetic text only.

  python3 server/scripts/parse_cc_statement_intl_test.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[1] / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT = Path(__file__).resolve().parent / "parse-cc-statement-pdfs.py"
spec = importlib.util.spec_from_file_location("parse_cc_statement_pdfs_intl", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["parse_cc_statement_pdfs_intl"] = mod
spec.loader.exec_module(mod)


class VerticalChunkRowTest(unittest.TestCase):
    """pdftotext's raw rendering: a chunk is a statement line only when it holds one printed
    line's two amounts and no page counter; any other chunk's row never survives the merge."""

    def _kept(self, chunk, fecha):
        row = mod._parse_international_vertical_chunk(chunk, fecha)
        return mod._merge_intl_parsed_rows([row] if row else [], [])

    def test_one_printed_line_is_a_row(self) -> None:
        rows = self._kept(["TIENDA DEMO", "CIUDAD DEMO", "GB", "10,00", "12,50"], "01/01/24")
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["amount_usd"], 12.5)
        self.assertAlmostEqual(rows[0]["amount_orig"], 10.0)
        self.assertEqual(rows[0]["country"], "GB")
        self.assertNotIn(mod.VERTICAL_MULTI_LINE, rows[0])

    def test_a_payment_whose_us_cell_moved_below_the_section_header_is_not_a_row(self) -> None:
        # The chunk holds only the origin column (printed unsigned); read as the US$ it was a
        # positive «ABONO DE DIVISAS» beside the real negative one from the layout rendering.
        self.assertEqual(
            self._kept(["ABONO DE DIVISAS", "CH", "25,00", "Demo.com/bill"], "02/01/24"), []
        )

    def test_the_page_counter_glued_to_a_page_s_last_row_is_not_a_row(self) -> None:
        # «3 DE 5» printed as «3» and «DE 5»: the page number read as the US$ amount.
        chunk = ["TIENDA DEMO", "CIUDAD DEMO", "GB", "10,00", "12,50", "3", "DE 5"]
        self.assertEqual(self._kept(chunk, "03/01/24"), [])

    def test_a_chunk_across_a_page_break_is_not_a_row(self) -> None:
        # The page number printed before the chunk's date; its «DE 2» still marks the break.
        self.assertEqual(self._kept(["TIENDA DEMO", "DE 2", "US", "8,00", "8,00"], "05/01/24"), [])

    def test_a_page_s_right_hand_columns_dumped_after_its_last_row_are_not_a_row(self) -> None:
        # The last row's chunk swallowed the next lines' country and amount cells; taking its
        # last two amounts paired this merchant with another line's US$.
        chunk = [
            "TIENDA DEMO",
            "US",
            "5.000,00",
            "5,50",
            "US",
            "20,00",
            "-20,00",
            "CH",
            "30,00",
            "-30,00",
        ]
        self.assertEqual(self._kept(chunk, "04/01/24"), [])


class MergeOrderTest(unittest.TestCase):
    def test_a_refused_vertical_row_keeps_the_order_the_layout_row_takes(self) -> None:
        # The layout row it shares a slot with replaces it in place, so the statement's rows
        # keep their order (and the row ids derived from it).
        vertical = mod._parse_international_vertical_chunk(
            ["TIENDA DEMO", "ES", "7,00", "7,00", "ES", "3,00", "3,00"], "06/01/24"
        )
        assert vertical is not None
        self.assertTrue(vertical.get(mod.VERTICAL_MULTI_LINE))
        layout = [
            mod._parse_intl_layout_table_line(
                "06/01/24   OTRA TIENDA          CIUDAD DEMO   ES      2,00      2,00"
            ),
            mod._parse_intl_layout_table_line(
                "06/01/24   TIENDA DEMO          CIUDAD DEMO   ES      3,00      3,00"
            ),
        ]
        rows = mod._merge_intl_parsed_rows([vertical], layout)
        self.assertEqual([r["amount_usd"] for r in rows], [3.0, 2.0])
        self.assertTrue(all(mod.VERTICAL_MULTI_LINE not in r for r in rows))


class LayoutLineCountryTest(unittest.TestCase):
    def test_a_two_letter_city_before_the_country_is_not_the_country(self) -> None:
        line = (
            "07/01/24   AEROLINEA DEMO 0000000000001              AB           NL      "
            "50,00     58,90"
        )
        row = mod._parse_intl_layout_table_line(line)
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["country"], "NL")
        self.assertEqual(row["place"], "AB")
        self.assertAlmostEqual(row["amount_usd"], 58.9)
        self.assertAlmostEqual(row["amount_orig"], 50.0)


class StatementRowsTest(unittest.TestCase):
    def test_a_payment_is_one_negative_line(self) -> None:
        vertical = "\n".join(
            [
                "1. TOTAL OPERACIONES",
                "12,00",
                "08/01/2024",
                "TIENDA DEMO",
                "US",
                "12,00",
                "12,00",
                "09/01/2024",
                "ABONO DE DIVISAS",
                "CH",
                "25,00",
                "Demo.com/bill",
                "3. CARGOS, COMISIONES, IMPUESTOS Y ABONO",
                "EMISOR",
                "-25,00",
            ]
        )
        layout = "\n".join(
            [
                "                    1. TOTAL OPERACIONES                                12,00",
                "     08/01/2024   TIENDA DEMO                     Demo.com/bill     US        12,00       12,00",
                "                    3. CARGOS, COMISIONES, IMPUESTOS Y ABONO           -25,00",
                "     09/01/2024   ABONO DE DIVISAS                                  CH        25,00      -25,00",
            ]
        )
        rows = mod.parse_international_usd_document(vertical, layout)
        abonos = [r for r in rows if r["merchant"] == "ABONO DE DIVISAS"]
        self.assertEqual([r["amount_usd"] for r in abonos], [-25.0])
        self.assertEqual(len(rows), 2)


class PrintedOriginTest(unittest.TestCase):
    """MONTO MONEDA ORIGEN reaches the CSV as printed; its currency is the importer's call."""

    @staticmethod
    def _emit(row):
        return mod.emit_row(
            card_group="INTL",
            source_pdf="demo usd.pdf",
            meta={"currency": "usd"},
            pr=row,
            raw_line="",
            row_id="demo-1",
        )

    def test_a_grouped_origin_is_read_whole_and_emitted_as_printed(self) -> None:
        row = mod._parse_intl_layout_table_line(
            "08/01/24   TIENDA DEMO          CIUDAD DEMO   GB      18.250,00      19,21"
        )
        assert row is not None
        self.assertEqual(row["amount_orig"], 18250.0)
        emitted = self._emit(row)
        self.assertEqual(emitted["amount_orig"], "18.250,00")
        self.assertEqual(emitted["orig_currency"], "")

    def test_a_dollar_origin_keeps_its_cents(self) -> None:
        row = mod._parse_international_vertical_chunk(["TIENDA DEMO", "US", "4,25", "4,25"], "09/01/24")
        assert row is not None
        self.assertEqual(row["amount_orig"], 4.25)
        self.assertEqual(self._emit(row)["amount_orig"], "4,25")

    def test_the_country_names_no_currency(self) -> None:
        for country in ("US", "NL", "GB", "CH", "ES", "AR"):
            with self.subTest(country=country):
                row = mod._build_intl_row("10/01/24", "TIENDA DEMO", country, "10,00", "12,50")
                assert row is not None
                self.assertNotIn("orig_currency", row)
                self.assertEqual(self._emit(row)["orig_currency"], "")

    def test_an_origin_that_is_not_a_printed_amount_stops_the_parse(self) -> None:
        row = mod._build_intl_row("11/01/24", "TIENDA DEMO", "US", "12.34", "12,34")
        assert row is not None
        self.assertIsNone(row["amount_orig"])
        with self.assertRaisesRegex(ValueError, "not a printed amount"):
            self._emit(row)

    def test_an_ocr_credit_note_reads_its_printed_origin_not_the_us_amount(self) -> None:
        flat = "05/01/24 | NOTA DE CREDITO [DEMO.COM [us | 7,50] 7,40] " + "x" * 120
        (row,) = mod.parse_international_usd_ocr_flat(
            flat,
            build_intl_row=mod._build_intl_row,
            intl_merchant_is_noise=mod._intl_merchant_is_noise,
        )
        self.assertEqual(row["amount_usd"], -7.4)
        self.assertEqual(row["amount_orig"], 7.5)


if __name__ == "__main__":
    unittest.main()
