#!/usr/bin/env python3
"""Tests for cartola column detection and summary reconcile."""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "cartola_layout.py"
spec = importlib.util.spec_from_file_location("cartola_layout", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cartola_layout"] = mod
spec.loader.exec_module(mod)


VISTA_MARCH_2025_SNIPPET = """
Saldo Inicial Cheques o Cargos Depósitos o Abonos Saldo Final
0 350.000 350.000 0
MOVIMIENTO DE SU CUENTA
FECHA NUMERO SUC DESCRIPCION CHEQUES Y DEPOSITOS Y SALDO
CARGOS ABONOS
  19/03 9250787 401 0768106274 Transf. 350.000
 1206262 401 Traspaso Internet a Cta. Cte. 350.000
"""

VISTA_LAYOUT_LINES = [
    "  FECHA          NUMERO             SUC                                DESCRIPCION                                      CHEQUES Y                           DEPOSITOS Y                                SALDO",
    "                                                                                                                         CARGOS                               ABONOS",
    "  19/03          9250787             401       0768106274 Transf.                                                                                                  350.000",
    "                 1206262             401       Traspaso Internet a Cta. Cte.                                                         350.000",
]


class CartolaLayoutTest(unittest.TestCase):
    def test_vista_summary_parse(self) -> None:
        s = mod.parse_vista_summary_totals(VISTA_MARCH_2025_SNIPPET)
        self.assertIsNotNone(s)
        assert s is not None
        self.assertEqual(s.saldo_inicial_clp, 0)
        self.assertEqual(s.total_cargos_clp, 350_000)
        self.assertEqual(s.total_abonos_clp, 350_000)
        self.assertEqual(s.saldo_final_clp, 0)

    def test_vista_column_split_classifies_cargo_and_abono(self) -> None:
        bounds = mod.detect_vista_column_bounds("\n".join(VISTA_LAYOUT_LINES))
        _, abono = mod.amounts_by_column(VISTA_LAYOUT_LINES[2], bounds)
        cargo, _ = mod.amounts_by_column(VISTA_LAYOUT_LINES[3], bounds)
        self.assertEqual(abono, 350_000)
        self.assertEqual(cargo, 350_000)

    def test_reconcile_rejects_both_as_credits(self) -> None:
        summary = mod.CartolaSummaryTotals(0, 350_000, 350_000, 0)
        movements = [
            type("M", (), {"amount_clp": 350_000})(),
            type("M", (), {"amount_clp": 350_000})(),
        ]
        err = mod.reconcile_cartola_movements(summary, movements)
        self.assertIsNotNone(err)
        self.assertIn("mismatch", err or "")

    def test_reconcile_ok_for_one_in_one_out(self) -> None:
        summary = mod.CartolaSummaryTotals(0, 350_000, 350_000, 0)
        movements = [
            type("M", (), {"amount_clp": 350_000})(),
            type("M", (), {"amount_clp": -350_000})(),
        ]
        self.assertIsNone(mod.reconcile_cartola_movements(summary, movements))

    def test_small_trailing_cargo_amount(self) -> None:
        bounds = mod.detect_vista_column_bounds("\n".join(VISTA_LAYOUT_LINES))
        line = (
            " 14/11         0008248           401       COMPRA RESTAURANTE DON I"
            "                                                 900"
        )
        cargo, abono = mod.amounts_by_column(line, bounds)
        self.assertEqual(cargo, 900)
        self.assertIsNone(abono)

    def test_small_trailing_abono_with_keyword(self) -> None:
        bounds = mod.detect_vista_column_bounds("\n".join(VISTA_LAYOUT_LINES))
        line = (
            " 19/03           9083210              1        principal adm gral:ABONO PRINC"
            "                                 566"
        )
        cargo, abono = mod.amounts_by_column(line, bounds)
        self.assertIsNone(cargo)
        self.assertEqual(abono, 566)

    def test_small_inline_cargo_amount(self) -> None:
        bounds = mod.AmountColumnBounds(cargo_abono_split=115, saldo_min=146)
        line = (
            "                                           0000011"
            "                                                            850"
            "                                         439.15"
        )
        cargo, abono = mod.amounts_by_column(line, bounds)
        self.assertEqual(cargo, 850)
        self.assertIsNone(abono)

    def test_single_digit_trailing_abono_with_hint(self) -> None:
        header = (
            "FECHA      SUCURSAL                            DESCRIPCION                            "
            "N° DCTO     CHEQUES Y OTROS    DEPOSITOS Y OTROS            SALDO\n"
            "                                                                                      "
            "CARGOS              ABONOS\n"
        )
        bounds = mod.detect_checking_column_bounds(header)
        line = (
            "            0965014500 P.PROVEEDOR     0965014500"
            "                                                                                    8"
        )
        cargo, abono = mod.amounts_by_column(line, bounds)
        self.assertIsNone(cargo)
        self.assertEqual(abono, 8)

    def test_saldo_column_amount_reads_saldo_dia_balance(self) -> None:
        bounds = mod.AmountColumnBounds(cargo_abono_split=150, saldo_min=120)
        line = (
            "                                           --- Saldo Dia ---"
            "                                                                                                     11.074"
        )
        self.assertEqual(mod.saldo_column_amount(line, bounds), 11_074)

    def test_validate_saldo_dia_chain_and_month_map(self) -> None:
        summary = mod.CartolaSummaryTotals(
            saldo_inicial_clp=1000,
            total_cargos_clp=500,
            total_abonos_clp=2500,
            saldo_final_clp=3000,
        )
        movements = [
            type("M", (), {"occurred_on": "2019-11-05", "amount_clp": 1500})(),
            type("M", (), {"occurred_on": "2019-12-28", "amount_clp": 500})(),
        ]
        saldo_dia = [
            ("2019-11-05", 2500),
            ("2019-12-28", 3000),
        ]
        month_map, err = mod.derive_month_saldo_final_clp(
            saldo_dia,
            movements,
            summary,
            "2019-11-01",
            "2019-12-31",
        )
        self.assertIsNone(err)
        assert month_map is not None
        self.assertEqual(month_map["2019-11"], 2500)
        self.assertEqual(month_map["2019-12"], 3000)

    def test_validate_saldo_dia_chain_fails_on_mismatch(self) -> None:
        summary = mod.CartolaSummaryTotals(1000, 0, 500, 1500)
        saldo_dia = [("2019-11-05", 9999)]
        movements = [type("M", (), {"occurred_on": "2019-11-05", "amount_clp": 500})()]
        err = mod.validate_saldo_dia_chain(saldo_dia, movements, summary)
        self.assertIsNotNone(err)
        self.assertIn("Saldo Dia", err or "")

    def test_expand_calendar_months_boundary_desde(self) -> None:
        self.assertEqual(
            mod.expand_calendar_months("2020-03-31", "2020-04-30"),
            ["2020-04"],
        )
        self.assertEqual(
            mod.expand_calendar_months("2018-11-01", "2019-10-31"),
            [
                "2018-11",
                "2018-12",
                "2019-01",
                "2019-02",
                "2019-03",
                "2019-04",
                "2019-05",
                "2019-06",
                "2019-07",
                "2019-08",
                "2019-09",
                "2019-10",
            ],
        )
        self.assertEqual(
            mod.expand_calendar_months("2016-10-28", "2017-10-31"),
            [
                "2016-11",
                "2016-12",
                "2017-01",
                "2017-02",
                "2017-03",
                "2017-04",
                "2017-05",
                "2017-06",
                "2017-07",
                "2017-08",
                "2017-09",
                "2017-10",
            ],
        )


    def test_effective_start_month_needs_both_bounds(self) -> None:
        with self.assertRaises(ValueError):
            mod.effective_cartola_start_ym("", "2026-08-31")
        with self.assertRaises(ValueError):
            mod.effective_cartola_start_ym("2026-08-01", None)


YEAR_CASES_PATH = SCRIPT.parents[1] / "src" / "test" / "cartolaMovementYearCases.json"


class CartolaRowDateTest(unittest.TestCase):
    def test_shared_case_table(self) -> None:
        """The table the TypeScript XLSX reader asserts too (agent-shared, byte-identical)."""
        cases = json.loads(YEAR_CASES_PATH.read_text(encoding="utf-8"))
        self.assertTrue(cases)
        for c in cases:
            with self.subTest(case=c):
                if c["expect"] is None:
                    with self.assertRaises(mod.CartolaRowDateError):
                        mod.cartola_row_date(c["day"], c["month"], c["desde"], c["hasta"])
                else:
                    self.assertEqual(
                        mod.cartola_row_date(c["day"], c["month"], c["desde"], c["hasta"]),
                        c["expect"],
                    )


class PdfCartolaRowDatesTest(unittest.TestCase):
    """Synthetic annual period 15/03/2021-31/03/2022: DD/MM from 15/03 to 31/03 fits both years."""

    def rows(self) -> "mod.PdfCartolaRowDates":
        return mod.PdfCartolaRowDates("sintetica.pdf", "2021-03-15", "2022-03-31")

    def test_unique_rows_take_the_base_rule(self) -> None:
        rows = self.rows()
        self.assertEqual(rows.resolve("02/04", "02/04 abono"), "2021-04-02")
        self.assertEqual(rows.resolve("05/02", "05/02 abono"), "2022-02-05")

    def test_ambiguous_row_takes_earliest_candidate_on_or_after_previous_row(self) -> None:
        rows = self.rows()
        rows.resolve("02/04", "02/04 abono")
        self.assertEqual(rows.resolve("20/03", "20/03 abono"), "2022-03-20")
        self.assertEqual(rows.resolve("20/03", "20/03 otro abono"), "2022-03-20")
        self.assertEqual(rows.resolve("31/03", "31/03 abono"), "2022-03-31")

    def test_ambiguous_first_row_raises_with_file_and_row(self) -> None:
        with self.assertRaises(mod.CartolaRowDateError) as ctx:
            self.rows().resolve("20/03", "20/03  Transf. de prueba")
        self.assertIn("sintetica.pdf", str(ctx.exception))
        self.assertIn("row «20/03 Transf. de prueba»", str(ctx.exception))

    def test_ambiguous_row_before_the_previous_row_raises(self) -> None:
        rows = self.rows()
        rows.resolve("05/02", "05/02 abono")
        rows.resolve("28/03", "28/03 abono")
        with self.assertRaises(mod.CartolaRowDateError) as ctx:
            rows.resolve("20/03", "20/03 abono")
        self.assertIn("2022-03-28", str(ctx.exception))

    def test_row_outside_the_period_raises(self) -> None:
        rows = mod.PdfCartolaRowDates("sintetica.pdf", "2026-08-01", "2026-08-31")
        with self.assertRaises(mod.CartolaRowDateError):
            rows.resolve("15/09", "15/09 abono")
        with self.assertRaises(mod.CartolaRowDateError):
            rows.resolve("31/02", "31/02 abono")

    def test_missing_period_start_raises(self) -> None:
        rows = mod.PdfCartolaRowDates("sintetica.pdf", None, "2026-08-31")
        with self.assertRaises(mod.CartolaRowDateError):
            rows.resolve("15/08", "15/08 abono")


if __name__ == "__main__":
    unittest.main()
