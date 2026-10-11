#!/usr/bin/env python3
"""Mortgage sheet rows from a synthetic cell grid: posted vs projected cuotas, pie, prepago, header check."""
from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mortgage_sheet import (  # noqa: E402
    COL,
    HEADER_CHECK,
    MortgageSheetError,
    cell,
    is_typed,
    payment_rows,
)

WIDTH = 79


def blank_row() -> list[dict]:
    return [cell(None) for _ in range(WIDTH)]


def header() -> list[dict]:
    r = blank_row()
    for col, text in HEADER_CHECK.items():
        r[col] = cell(text)
    return r


def row(label, date, pago_uf, uf_day, *, typed=True, **cols) -> list[dict]:
    """A cuota row. `typed=False` makes the posted cells formulas (a projection)."""
    r = blank_row()
    r[COL["label"]] = cell(label)
    r[COL["date"]] = cell(date)
    posted = (lambda v: cell(v)) if typed else (lambda v: cell(v, True, "X1×Y1"))
    r[COL["pago_uf"]] = posted(pago_uf)
    r[COL["uf_day"]] = posted(uf_day)
    r[COL["pago_clp"]] = cell(round(pago_uf * uf_day), True, "J5")
    for k, v in cols.items():
        r[COL[k]] = cell(v, True, "formula")
    # The bank's three UF figures are typed as bare-number formulas («=10.5»).
    if "min_uf" in cols:
        r[COL["min_uf"]] = posted(cols["min_uf"]) if not typed else cell(cols["min_uf"], True, str(cols["min_uf"]))
    if "max_uf" in cols:
        r[COL["max_uf"]] = posted(cols["max_uf"]) if not typed else cell(cols["max_uf"], True, str(cols["max_uf"]))
    if "interes_clp" in cols:
        r[COL["interes_clp"]] = posted(cols["interes_clp"])
    return r


def cuota_cols(**over):
    base = dict(
        interes_clp=300000,
        min_uf=11.0,
        max_uf=80.0,
        incendio_clp=40000,
        incendio_uf=1.0,
        desgravamen_clp=4000,
        desgravamen_uf=0.1,
        amortizacion_clp=96000,
        amortizacion_uf=2.4,
        amortizacion_ext_clp=360000,
        amortizacion_ext_uf=9.0,
        credito_restante_uf=2988.6,
        valor_vivienda_uf=5400,
    )
    base.update(over)
    return base


class IsTypedTest(unittest.TestCase):
    def test_values_and_literal_formulas_are_typed(self):
        self.assertTrue(is_typed(cell(10.5)))
        self.assertTrue(is_typed(cell(10.5, True, "10.5")))
        self.assertTrue(is_typed(cell(-1.5, True, " -1.5 ")))

    def test_formulas_and_blanks_are_not(self):
        self.assertFalse(is_typed(cell(10.85, True, "K37×4.95÷12÷100")))
        self.assertFalse(is_typed(cell(1700.0, True, None)))  # a formula the reader could not render
        self.assertFalse(is_typed(cell(None)))
        self.assertFalse(is_typed(cell("")))
        self.assertFalse(is_typed(None))


class PaymentRowsTest(unittest.TestCase):
    def test_posted_cuota_pie_and_prepago_in_sheet_order_projected_left_out(self):
        pie = blank_row()
        pie[COL["label"]] = cell("pie")
        pie[COL["date"]] = cell(dt.datetime(2024, 4, 4))
        pie[COL["pago_clp"]] = cell(58000000.0, True, "D4×F4")
        pie[COL["pago_uf"]] = cell(1450.0)
        pie[COL["uf_day"]] = cell(40000.0)
        pie[COL["credito_restante_uf"]] = cell(3950.0)
        pie[COL["valor_vivienda_uf"]] = cell(5400.0)
        prepago = blank_row()
        prepago[COL["label"]] = cell("prepago 1")
        prepago[COL["date"]] = cell(dt.datetime(2024, 11, 18))
        prepago[COL["pago_clp"]] = cell(4025000.0)
        prepago[COL["pago_uf"]] = cell(100.625)
        prepago[COL["uf_day"]] = cell(40000.0)
        prepago[COL["credito_restante_uf"]] = cell(2888.6, True, None)
        prepago[COL["amortizacion_ext_clp"]] = cell(4000000.0, True, "C11-SUM(...)")
        prepago[COL["amortizacion_ext_uf"]] = cell(100.0, True, "ROUND(...)")
        prepago[COL["interes_clp"]] = cell(25000.0, True, "20000+5000")
        prepago[COL["valor_vivienda_uf"]] = cell(5400.0)
        grid = [
            header(),
            pie,
            row(32.0, dt.datetime(2026, 10, 11), 20.0, 40000.0, **cuota_cols()),
            prepago,
            row(33.0, dt.datetime(2026, 11, 11), 18.0, 40100.0, typed=False, **cuota_cols(credito_restante_uf=2877.2)),
            blank_row(),
        ]
        out = payment_rows(grid)
        self.assertEqual(out["projected"], ["33"])
        self.assertEqual([r["label"] for r in out["rows"]], ["pie", "32", "prepago 1"])
        pie_row, c32, pp = out["rows"]
        self.assertEqual(pie_row["kind"], "pie")
        self.assertEqual(pie_row["pago_clp"], 58000000)
        self.assertEqual(pie_row["pago_uf"], 1450.0)
        self.assertIsNone(pie_row["interes_clp"])
        self.assertEqual(c32["kind"], "cuota")
        self.assertEqual(c32["paid_on"], "2026-10-11")
        self.assertEqual(c32["pago_clp"], 800000)
        self.assertEqual(c32["pago_uf"], 20.0)
        self.assertEqual(c32["uf_day"], 40000.0)
        self.assertEqual(c32["min_uf"], 11.0)
        self.assertEqual(c32["max_uf"], 80.0)
        self.assertEqual(c32["interes_clp"], 300000)
        self.assertEqual(c32["incendio_uf"], 1.0)
        self.assertEqual(c32["amortizacion_ext_clp"], 360000)
        self.assertEqual(c32["credito_restante_uf"], 2988.6)
        self.assertEqual(pp["kind"], "prepago")
        self.assertEqual(pp["label"], "prepago 1")
        self.assertEqual(pp["amortizacion_ext_clp"], 4000000)
        self.assertEqual(pp["interes_clp"], 25000)

    def test_pago_uf_as_a_formula_does_not_make_a_projection(self):
        r = row(32.0, dt.datetime(2026, 10, 11), 80.0, 40000.0, **cuota_cols(amortizacion_ext_clp=2760000, amortizacion_ext_uf=69.0, credito_restante_uf=2928.6))
        r[COL["pago_uf"]] = cell(80.0, True, "AF37")
        r[COL["pago_clp"]] = cell(3200000.0, True, "J37")
        out = payment_rows([header(), r])
        self.assertEqual([x["label"] for x in out["rows"]], ["32"])
        self.assertEqual(out["rows"][0]["pago_uf"], 80.0)

    def test_a_cuota_with_one_formula_cell_is_still_a_projection(self):
        r = row(33.0, dt.datetime(2026, 11, 11), 18.0, 40100.0, **cuota_cols())
        r[COL["interes_clp"]] = cell(299000.5, True, "BO38×F38")
        out = payment_rows([header(), r])
        self.assertEqual(out["rows"], [])
        self.assertEqual(out["projected"], ["33"])

    def test_moved_header_fails(self):
        h = header()
        h[COL["interes_clp"]] = cell("interés real")
        with self.assertRaises(MortgageSheetError):
            payment_rows([h, row(1.0, dt.datetime(2026, 1, 11), 18.0, 40000.0, **cuota_cols())])

    def test_unknown_label_fails_and_fractional_pesos_round(self):
        r = row(32.0, dt.datetime(2026, 10, 11), 20.0, 40000.0, **cuota_cols())
        r[COL["label"]] = cell("cuota extra")
        with self.assertRaises(MortgageSheetError):
            payment_rows([header(), r])
        r2 = row(32.0, dt.datetime(2026, 10, 11), 20.0, 40000.0, **cuota_cols(amortizacion_clp=96000.4))
        self.assertEqual(payment_rows([header(), r2])["rows"][0]["amortizacion_clp"], 96000)

    def test_footer_rows_are_skipped_and_numbering_gaps_fail(self):
        footer = blank_row()
        footer[COL["label"]] = cell(1769.9999, True, "K37")
        out = payment_rows([header(), row(1.0, dt.datetime(2026, 1, 11), 18.0, 40000.0, **cuota_cols()), footer])
        self.assertEqual([r["label"] for r in out["rows"]], ["1"])
        # The first cuota may be any number (the sheet starts where its records start); a gap after it fails.
        first = payment_rows([header(), row(4.0, dt.datetime(2026, 1, 11), 18.0, 40000.0, **cuota_cols())])
        self.assertEqual([r["label"] for r in first["rows"]], ["4"])
        with self.assertRaises(MortgageSheetError):
            payment_rows([
                header(),
                row(4.0, dt.datetime(2026, 1, 11), 18.0, 40000.0, **cuota_cols()),
                row(6.0, dt.datetime(2026, 3, 11), 18.0, 40000.0, **cuota_cols()),
            ])

    def test_duplicate_label_fails(self):
        a = row(1.0, dt.datetime(2026, 10, 11), 20.0, 40000.0, **cuota_cols())
        a[COL["label"]] = cell("prepago 1")
        b = row(1.0, dt.datetime(2026, 11, 11), 20.0, 40000.0, **cuota_cols())
        b[COL["label"]] = cell("prepago 1")
        with self.assertRaises(MortgageSheetError):
            payment_rows([header(), a, b])


if __name__ == "__main__":
    unittest.main()
