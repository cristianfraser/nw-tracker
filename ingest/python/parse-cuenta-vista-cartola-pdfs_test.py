#!/usr/bin/env python3
"""Tests for the cuenta vista cartola PDF parser.

Synthetic cartola text parses through `parse_cartola_text`; the one real-document test skips when
the personal corpus (cfraser/, main checkout only) is absent.

  python3 ingest/python/parse-cuenta-vista-cartola-pdfs_test.py
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "parse-cuenta-vista-cartola-pdfs.py"
spec = importlib.util.spec_from_file_location("parse_cv", SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules["parse_cv"] = mod
spec.loader.exec_module(mod)


def _cells(*cells: tuple) -> str:
    """One `pdftotext -layout` line: each text at its column."""
    line = ""
    for col, text in cells:
        line = line.ljust(col) + text
    return line


def _row(dd_mm: str, doc: str, description: str, *, cargo: str = "", abono: str = "") -> str:
    cells = [(2, dd_mm), (17, doc), (36, "401"), (46, description)]
    if cargo:
        cells.append((121, cargo))
    if abono:
        cells.append((158, abono))
    return _cells(*cells)


def _saldo_dia(amount: str) -> str:
    return _cells((54, "--- Saldo Dia ---"), (205, amount))


def synthetic_annual_cartola(first_row_dd_mm: str = "02/04") -> str:
    """An annual cuenta vista (DESDE 15/03/2021, HASTA 31/03/2022) whose last rows, 28/03 and 31/03,
    fit both years of the period."""
    return "\n".join(
        [
            _cells((3, "ESTADO CUENTAMATICA"), (100, "CARTOLA"), (117, "DESDE"), (133, "HASTA")),
            _cells((16, "0-000-00-00000-0"), (104, "1"), (114, "15/03/2021 31/03/2022"), (145, "1 DE 1")),
            "Saldo Inicial        Cheques o Cargos        Depósitos o Abonos        Saldo Final",
            "10.000               2.000                   7.500                     15.500",
            "MOVIMIENTO DE SU CUENTA",
            _cells(
                (2, "FECHA"), (17, "NUMERO"), (36, "SUC"), (71, "DESCRIPCION"),
                (120, "CHEQUES Y"), (156, "DEPOSITOS Y"), (199, "SALDO"),
            ),
            _cells((121, "CARGOS"), (158, "ABONOS")),
            _row(first_row_dd_mm, "1000001", "Transf. de prueba uno", abono="5.000"),
            _saldo_dia("15.000"),
            _row("10/12", "1000002", "Compra de prueba", cargo="2.000"),
            _saldo_dia("13.000"),
            _row("05/02", "1000003", "Transf. de prueba dos", abono="1.000"),
            _saldo_dia("14.000"),
            _row("28/03", "1000004", "Transf. de prueba tres", abono="1.000"),
            _saldo_dia("15.000"),
            _row("31/03", "1000005", "Transf. de prueba cuatro", abono="500"),
            _saldo_dia("15.500"),
            "Resumen de Comisiones",
        ]
    )


class SyntheticAnnualCartolaTest(unittest.TestCase):
    def test_row_order_settles_dates_that_fit_two_years(self) -> None:
        parsed = mod.parse_cartola_text(synthetic_annual_cartola(), "sintetica.pdf")
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        self.assertEqual((parsed.period_from, parsed.period_to), ("2021-03-15", "2022-03-31"))
        self.assertEqual(
            [(m.occurred_on, m.amount_clp) for m in parsed.movements],
            [
                ("2021-04-02", 5_000),
                ("2021-12-10", -2_000),
                ("2022-02-05", 1_000),
                ("2022-03-28", 1_000),
                ("2022-03-31", 500),
            ],
        )
        assert parsed.month_saldo_final_clp is not None
        self.assertEqual(parsed.month_saldo_final_clp["2021-04"], 15_000)
        self.assertEqual(parsed.month_saldo_final_clp["2021-12"], 13_000)
        self.assertEqual(parsed.month_saldo_final_clp["2022-03"], 15_500)

    def test_ambiguous_first_row_is_a_parse_error_naming_file_and_row(self) -> None:
        parsed = mod.parse_cartola_text(synthetic_annual_cartola("20/03"), "sintetica.pdf")
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("sintetica.pdf", parsed.parse_error or "")
        self.assertIn("Transf. de prueba uno", parsed.parse_error or "")
        self.assertEqual(parsed.movements, [])


class RealCartolaTest(unittest.TestCase):
    def test_multi_month_2017_saldo_dia_month_map(self) -> None:
        pdf = (
            Path(__file__).resolve().parents[2]
            / "cfraser/cartolas-cuenta-vista/2017-10-31 cartola cuenta vista.pdf"
        )
        if not pdf.is_file():
            self.skipTest(f"personal corpus not present: {pdf}")
        parsed = mod.parse_cartola_pdf(pdf)
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        assert parsed.month_saldo_final_clp is not None
        self.assertEqual(parsed.month_saldo_final_clp.get("2016-11"), 104_085)
        self.assertEqual(parsed.month_saldo_final_clp.get("2017-10"), 2_371_355)


if __name__ == "__main__":
    unittest.main()
