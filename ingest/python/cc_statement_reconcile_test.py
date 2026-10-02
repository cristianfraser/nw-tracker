#!/usr/bin/env python3
"""Unit tests for CC statement reconcile helpers (synthetic data only)."""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from typing import Optional

# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[2] / "server" / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

SCRIPT = SCRIPT_DIR / "cc_statement_reconcile.py"
spec = importlib.util.spec_from_file_location("cc_statement_reconcile", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cc_statement_reconcile"] = mod
spec.loader.exec_module(mod)


def parse_clp(raw: str) -> Optional[int]:
    s = str(raw or "").strip().replace(".", "")
    if not s or s in {"-", "$"}:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_usd(raw: str) -> Optional[float]:
    s = str(raw or "").strip().replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


# One synthetic rendering of a BCI/Líder EECC: transaction amounts share their line with
# text (never counted), group subtotals print as lone `$ amount` lines (counted).
BCI_RENDERING = """BANCO DE CREDITO E INVERSIONES
Numero tarjeta XXXXXXXXXXXX4343
1. Total Operaciones
LIDER
SANTIAGO CL 05/08/2026 TIENDA UNO (T) $ 10.000
SANTIAGO CL 09/08/2026 TIENDA DOS (T) $ 20.000
$ 30.000
OTROS COMERCIOS
SANTIAGO CL 12/08/2026 SERVICIO TRES (T) $ 70.000
$ 70.000
2. Productos o Servicios Voluntariamente Contratados
3. Cargos / Comisiones, Impuestos / Abonos
30/07/2026 PAGO $ -95.000
$ -95.000
Monto Total Facturado
$ 100.000
"""


class BciSubsectionTotalsTest(unittest.TestCase):
    def test_single_rendering_sums_group_subtotals_only(self) -> None:
        op, cargos, monto = mod._bci_subsection_totals_clp(BCI_RENDERING, parse_clp, parse_usd)
        self.assertEqual(op, 100000.0)
        self.assertIsNone(cargos)  # negative-only section 3 stays uncollected
        self.assertEqual(monto, 100000.0)

    def test_concatenated_dual_rendering_must_not_double(self) -> None:
        # The parse flow hands extract_pdf_section_totals BOTH extractions concatenated
        # (pypdf + pdftotext-layout). Summing collectors must work on ONE rendering:
        # the concat doubled pdf_total_operaciones on the 2026 mail-template statements
        # (2026-08 ·0101: 3.xxx.xxx = 2 x 1.xxx.xxx), which disarmed the import-level
        # monto_facturado check via its incomplete-parse hatch.
        concat = f"{BCI_RENDERING}\n{BCI_RENDERING}"
        totals = mod.extract_pdf_section_totals(
            concat, "clp", parse_clp, parse_usd, layout_text=BCI_RENDERING
        )
        self.assertEqual(totals["pdf_total_operaciones"], 100000.0)
        self.assertEqual(totals["pdf_monto_facturado"], 100000.0)

    def test_single_text_callers_keep_working_without_layout(self) -> None:
        totals = mod.extract_pdf_section_totals(BCI_RENDERING, "clp", parse_clp, parse_usd)
        self.assertEqual(totals["pdf_total_operaciones"], 100000.0)


def _row(merchant: str, amount: str, layout: str, currency: str = "clp", key: str = "") -> dict:
    return {
        "currency": currency,
        "merchant": merchant,
        "amount_clp": amount if currency == "clp" else "",
        "amount_usd": amount if currency == "usd" else "",
        "parser_layout": layout,
        "installment_flag": "false",
        "is_duplicate_across_statements": "false",
        "row_id": key or f"{merchant}|{amount}",
        "transaction_date": "05/06/26",
    }


class SumParsedSectionsTest(unittest.TestCase):
    """Sums go through the shared line rules (cc_statement_line_rules.py), synthetic rows."""

    def test_bci_section3_rows_net_by_layout(self) -> None:
        sums = mod.sum_parsed_sections(
            [
                _row("TIENDA UNO (T)", "100000", "bci_lider_operaciones"),
                _row("IMPUESTO DL 3475 C. CONTADO (T)", "500", "bci_lider_cargos"),
                _row("TIENDA ONLINE (T)", "-12000", "bci_lider_cargos"),
                _row("PAGO", "-95000", "bci_lider_cargos"),
            ],
            parse_clp,
            parse_usd,
        )
        self.assertEqual(sums["parsed_operaciones"], 100000.0)
        self.assertEqual(sums["parsed_cargos_abonos"], 500.0 - 12000.0)
        self.assertEqual(sums["parsed_mid_period_payments"], -95000.0)

    def test_legacy_usd_monto_cancelado_stays_out_of_section_3(self) -> None:
        sums = mod.sum_parsed_sections(
            [
                _row("TIENDA EJEMPLO", "50,00", "international_usd", "usd"),
                _row("INTERESES", "-5,25", "international_usd", "usd"),
                _row("MONTO CANCELADO", "-1000,00", "international_usd", "usd"),
                _row("TRASPASO DE DEUDA INTERNACIONAL", "-60,00", "international_usd", "usd"),
            ],
            parse_clp,
            parse_usd,
        )
        self.assertEqual(sums["parsed_operaciones"], 50.0)
        self.assertAlmostEqual(sums["parsed_cargos_abonos"], -5.25 - 60.0)
        self.assertAlmostEqual(sums["parsed_traspaso_nacional"], -60.0)


class NextBillingPeriodTest(unittest.TestCase):
    """«Próximo período de facturación»: the next close, printed by both issuers (synthetic text)."""

    def _next(self, layout: str, full: str = "", currency: str = "clp"):
        out = mod.extract_pdf_section_totals(
            f"{full}\n{layout}", currency, parse_clp, parse_usd, layout_text=layout
        )
        return out["pdf_next_period_from"], out["pdf_next_period_to"]

    def test_santander_layout_line(self) -> None:
        layout = "PRÓXIMO PERÍODO DE FACTURACIÓN                 25/08/2026             24/09/2026\n"
        self.assertEqual(self._next(layout), ("25/08/2026", "24/09/2026"))

    def test_bci_layout_line_with_trailing_amount(self) -> None:
        layout = "Próximo Período de Facturación      27/08/2026        26/09/2026        1.233.517\n"
        self.assertEqual(self._next(layout), ("27/08/2026", "26/09/2026"))

    def test_split_label_in_pypdf_rendering(self) -> None:
        full = "PROXIMO PERIODO DE FACTURACION\n25/08/2026\n24/09/2026\n"
        self.assertEqual(self._next("", full), ("25/08/2026", "24/09/2026"))

    def test_absent_or_reversed_period_is_none(self) -> None:
        self.assertEqual(self._next("PERIODO FACTURADO 23/07/2026 25/08/2026\n"), (None, None))
        reversed_period = "PRÓXIMO PERÍODO DE FACTURACIÓN 24/09/2026 25/08/2026\n"
        self.assertEqual(self._next(reversed_period), (None, None))


if __name__ == "__main__":
    unittest.main()
