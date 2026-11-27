#!/usr/bin/env python3
"""Wide-layout (e-mailed Santander statement) row parsing — synthetic text only."""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[2] / "server" / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT = Path(__file__).resolve().parent / "parse-cc-statement-pdfs.py"
spec = importlib.util.spec_from_file_location("parse_cc_statement_pdfs_wide", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["parse_cc_statement_pdfs_wide"] = mod
spec.loader.exec_module(mod)

import cc_statement_reconcile  # noqa: E402  (on sys.path once the parser module loaded)


class WidePeriodicSummaryRowTest(unittest.TestCase):
    """Section «4. INFORMACION COMPRAS EN CUOTAS EN EL PERIODO»: a cuota purchase of the cycle."""

    def _periodic_rows(self, text: str):
        return [
            r for r in mod.parse_wide_document(text) if r["layout"] == "wide_master_periodic_summary"
        ]

    def test_amount_is_the_principal_like_every_other_installment_layout(self) -> None:
        # The manual-plan reconcile compares the stored line amount with a plan's total: a cuota
        # here left a hand-entered plan beside the statement's own plan for the same purchase.
        text = "\n".join(
            [
                "4. INFORMACION COMPRAS EN CUOTAS EN EL PERIODO                     $ 110.000",
                "12/08/2026 TIENDA DEMO UNO           03 CUOTAS COMERC        0,00 %      "
                "$ 300.000       $ 300.000                       $ 100.000",
                "13/08/2026 TIENDA DEMO DOS           06 CUOTAS COMERC        0,00 %      "
                "$ 60.000        $ 60.000                        $ 10.000",
            ]
        )
        rows = self._periodic_rows(text)
        self.assertEqual(
            [
                (
                    r["merchant"],
                    r["amount_clp"],
                    r["monto_origen_operacion_clp"],
                    r["valor_cuota_mensual_clp"],
                    r["nro_cuota_total"],
                )
                for r in rows
            ],
            [
                ("TIENDA DEMO UNO", 300000, 300000, 100000, 3),
                ("TIENDA DEMO DOS", 60000, 60000, 10000, 6),
            ],
        )

    def test_stays_out_of_operaciones(self) -> None:
        # The section total prints the first cuotas; the rows never count toward operaciones
        # whatever their amount (the reconcile skips the layout by name).
        text = (
            "12/08/2026 TIENDA DEMO UNO           03 CUOTAS COMERC        0,00 %      "
            "$ 300.000       $ 300.000                       $ 100.000"
        )
        (row,) = self._periodic_rows(text)
        self.assertFalse(cc_statement_reconcile._installment_cuota_counts_toward_operaciones(row))


class PrintedPaymentTest(unittest.TestCase):
    """A bill paid WITH the card (positive) is a charge, not a payment to the card (synthetic)."""

    def test_payment_names_and_signs(self) -> None:
        self.assertTrue(mod._is_printed_payment("PAGO", -95000))
        self.assertTrue(mod._is_printed_payment("MONTO CANCELADO", -799289))
        self.assertTrue(mod._is_printed_payment("PAGO TARJETA", -1000))
        self.assertFalse(mod._is_printed_payment("PAGO FACIL", 88800))
        self.assertFalse(mod._is_printed_payment("PAGOS.FLOW.CL (WEB)", 125716))
        self.assertFalse(mod._is_printed_payment("TIENDA DEMO", -5000))

    def test_compact_payment_line_leaves_a_positive_pago_facil_alone(self) -> None:
        self.assertIsNone(mod._try_parse_compact_payment_line("02/08/36 PAGO FACIL $ 88.800"))
        pay = mod._try_parse_compact_payment_line("01/08/36 MONTO CANCELADO $ -79.928")
        self.assertIsNotNone(pay)
        self.assertEqual(pay["amount_clp"], -79928)

    def test_compact_purchase_row_keeps_a_positive_pago_facil(self) -> None:
        row = {"merchant": "PAGO FACIL", "place": "SANTIAGO", "description_raw": "", "amount_clp": 88800}
        self.assertFalse(mod._compact_should_skip_purchase_row(row))
        paid = {"merchant": "PAGO", "place": "", "description_raw": "", "amount_clp": -88800}
        self.assertTrue(mod._compact_should_skip_purchase_row(paid))


def _row(layout: str, day: str, merchant: str, amount: int, raw: str = "") -> dict:
    return {
        "layout": layout,
        "transaction_date": day,
        "merchant": merchant,
        "amount_clp": amount,
        "description_raw": raw or f"{day} SANTIAGO {merchant} $ {amount}",
    }


def _compact(day: str, merchant: str, amount: int, beside: str = "") -> dict:
    # The pypdf line glues date, place, any other column, amount and merchant.
    return _row(
        "compact_de_simple", day, merchant, amount, f"{day}SANTIAGO {beside} ${amount}{merchant}"
    )


def _wide(day: str, merchant: str, amount: int) -> dict:
    return _row("wide_master_simple", day, merchant, amount)


class SantanderClpReadingsMergeTest(unittest.TestCase):
    """The compact (pypdf) and wide (layout) readings of one printed line are one row."""

    def setUp(self) -> None:
        mod.SANTANDER_CLP_UNPAIRED_READINGS.clear()

    def _merged(self, compact, wide):
        return [
            (r["layout"], r["merchant"], r["amount_clp"])
            for r in mod._merge_santander_clp_row_lists(compact, wide)
        ]

    def test_readings_differing_by_internal_spaces_merge(self) -> None:
        self.assertEqual(
            self._merged(
                [_compact("03/10/2036", "DEMO   *RIDE SHOP", 5100)],
                [_wide("03/10/2036", "DEMO *RIDE SHOP", 5100)],
            ),
            [("wide_master_simple", "DEMO *RIDE SHOP", 5100)],
        )

    def test_readings_differing_by_letter_case_merge(self) -> None:
        self.assertEqual(
            self._merged(
                [_compact("03/10/2036", "Demo Ride Shop", 5100)],
                [_wide("03/10/2036", "DEMO RIDE SHOP", 5100)],
            ),
            [("wide_master_simple", "DEMO RIDE SHOP", 5100)],
        )

    def test_a_neighbouring_column_the_wide_reading_appended_merges(self) -> None:
        self.assertEqual(
            self._merged(
                [
                    _compact("06/10/2036", "SEGURO DEMO", 21000, "COMPRAS P.A.T."),
                    _row(
                        "compact_cargos_charge",
                        "05/10/2036",
                        "IMPTO. DEMO LEY 1",
                        400,
                        "05/10/2036SANTIAGO 0,066 %TIENDA DEMO X $400IMPTO. DEMO LEY 1",
                    ),
                ],
                [
                    _wide("06/10/2036", "SEGURO DEMO          COMPRAS P.A.T.", 21000),
                    _wide("05/10/2036", "IMPTO. DEMO LEY 1     TIENDA DEMO X   0,066 %", 400),
                ],
            ),
            [
                # Which reading's text is kept follows the layout rank, as for every merge.
                ("wide_master_simple", "SEGURO DEMO          COMPRAS P.A.T.", 21000),
                ("compact_cargos_charge", "IMPTO. DEMO LEY 1", 400),
            ],
        )
        self.assertEqual(mod.SANTANDER_CLP_UNPAIRED_READINGS, [])

    def test_a_column_appended_after_a_single_space_merges(self) -> None:
        self.assertEqual(
            self._merged(
                [_compact("06/10/2036", "SEGURO DEMO", 21000, "COMPRAS P.A.T.")],
                [_wide("06/10/2036", "SEGURO DEMO COMPRAS P.A.T.", 21000)],
            ),
            [("wide_master_simple", "SEGURO DEMO COMPRAS P.A.T.", 21000)],
        )

    def test_trailing_text_that_is_no_column_of_the_line_keeps_two_purchases(self) -> None:
        # «SHOP» only in one reading, «SHOP  ANNEX» only in the other: the compact line
        # prints no «ANNEX» beside its merchant, so it is another purchase.
        merged = self._merged(
            [_compact("08/10/2036", "SHOP", 900)],
            [_wide("08/10/2036", "SHOP  ANNEX", 900)],
        )
        self.assertEqual(
            merged,
            [("compact_de_simple", "SHOP", 900), ("wide_master_simple", "SHOP  ANNEX", 900)],
        )

    def test_both_readings_left_with_rows_of_a_date_and_amount_are_recorded(self) -> None:
        self._merged(
            [_compact("08/10/2036", "SHOP", 900), _compact("09/10/2036", "CAFE DEMO", 700)],
            [_wide("08/10/2036", "SHOP  ANNEX", 900), _wide("09/10/2036", "CAFE DEMO", 700)],
        )
        self.assertEqual(mod.SANTANDER_CLP_UNPAIRED_READINGS, [("08/10/2036", "900")])

    def test_a_cut_never_takes_the_name_of_a_row_paired_exactly(self) -> None:
        for compact in (
            [_compact("11/10/2036", "DEMO   *FOOD", 800, "*FOOD"), _compact("11/10/2036", "DEMO", 800)],
            [_compact("11/10/2036", "DEMO", 800), _compact("11/10/2036", "DEMO   *FOOD", 800, "*FOOD")],
        ):
            merged = self._merged(compact, [_wide("11/10/2036", "DEMO", 800)])
            self.assertEqual(
                sorted(m for _l, m, _a in merged), ["DEMO", "DEMO   *FOOD"], msg=str(compact)
            )

    def test_the_longest_cut_pairs_first(self) -> None:
        merged = self._merged(
            [
                _compact("12/10/2036", "TIENDA", 600, "NORTE COMPRAS"),
                _compact("12/10/2036", "TIENDA NORTE", 600, "COMPRAS"),
            ],
            [_wide("12/10/2036", "TIENDA  NORTE  COMPRAS", 600)],
        )
        self.assertEqual(
            merged,
            [("compact_de_simple", "TIENDA", 600), ("wide_master_simple", "TIENDA  NORTE  COMPRAS", 600)],
        )

    def test_identical_purchases_in_both_readings_stay_two(self) -> None:
        merged = self._merged(
            [_compact("09/10/2036", "DEMO   *FOOD", 7000), _compact("09/10/2036", "DEMO   *FOOD", 7000)],
            [_wide("09/10/2036", "DEMO *FOOD", 7000), _wide("09/10/2036", "DEMO *FOOD", 7000)],
        )
        self.assertEqual(merged, [("wide_master_simple", "DEMO *FOOD", 7000)] * 2)

    def test_a_twin_twice_in_one_reading_and_once_in_the_other_keeps_two(self) -> None:
        merged = self._merged(
            [
                _compact("10/10/2036", "PEAJE DEMO", 1500, "COMPRAS P.A.T."),
                _compact("10/10/2036", "PEAJE DEMO", 1500, "COMPRAS P.A.T."),
            ],
            [_wide("10/10/2036", "PEAJE DEMO          COMPRAS P.A.T.", 1500)],
        )
        self.assertEqual(
            merged,
            [
                ("wide_master_simple", "PEAJE DEMO          COMPRAS P.A.T.", 1500),
                ("compact_de_simple", "PEAJE DEMO", 1500),
            ],
        )


if __name__ == "__main__":
    unittest.main()
