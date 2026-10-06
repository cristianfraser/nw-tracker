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


if __name__ == "__main__":
    unittest.main()
