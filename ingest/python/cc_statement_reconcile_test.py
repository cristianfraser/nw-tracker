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

    def test_a_prepaid_plan_is_section_3_and_a_00_n_cuota_bills_nothing(self) -> None:
        new_plan = {
            **_row("PLAN NUEVO", "90000", "wide_master_precio_summary", key="n"),
            "installment_flag": "true",
            "valor_cuota_mensual_clp": "30000",
            "nro_cuota_current": "",
            "nro_cuota_total": "3",
        }
        old_plan = {**new_plan, "merchant": "PLAN VIEJO", "row_id": "o", "nro_cuota_current": "2"}
        sums = mod.sum_parsed_sections(
            [
                _row("TIENDA UNO", "50000", "wide_master_simple"),
                _row("PREPAGO EN CUOTAS", "40000", "wide_master_simple"),
                _row("DEVOLUCION TIENDA", "-2000", "wide_master_simple"),
                _row("MONTO CANCELADO", "-60000", "wide_master_date_first"),
                new_plan,
                old_plan,
            ],
            parse_clp,
            parse_usd,
        )
        self.assertEqual(sums["parsed_operaciones"], 80000)
        self.assertEqual(sums["parsed_cargos_abonos"], 40000)
        self.assertEqual(sums["parsed_operaciones_credits"], -2000)

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


class OperacionesShortfallTest(unittest.TestCase):
    """A Santander peso statement read from its text may not lose printed lines (synthetic)."""

    SOURCE = "2036-08-24 estado de cuenta tarjeta 4141.pdf"  # a primary card of the fixture registry

    def _full(self) -> str:
        return "\n".join(
            [
                "MONTO FACTURADO A PAGAR (PERIODO ANTERIOR)                 $ 61.816",
                "MONTO PAGADO PERIODO ANTERIOR                              $ -79.928",
                "SALDO ADEUDADO FINAL PERIODO ANTERIOR                      $ -18.112",
                "1. TOTAL OPERACIONES                                       $ 11.097",
                "SANTIAGO        02/08/2036 TIENDA DEMO                     $ 2.217",
                "SANTIAGO        03/08/2036 PAGO FACIL                      $ 8.880",
                "MONTO TOTAL FACTURADO A PAGAR                              $ 92.862",
            ]
        )

    def _check(self, rows, full):
        result = mod.reconcile_statement(
            self.SOURCE, {"currency": "clp"}, rows, full, parse_clp, parse_usd, layout_text=full
        )
        return next(c for c in result.checks if c.code == "operaciones_shortfall")

    def test_a_dropped_charge_fails(self) -> None:
        check = self._check([_row("TIENDA DEMO", "2217", "wide_master_simple", key="a")], self._full())
        self.assertFalse(check.ok)
        self.assertEqual(check.delta, -8880.0)

    def test_every_printed_line_passes(self) -> None:
        rows = [
            _row("TIENDA DEMO", "2217", "wide_master_simple", key="a"),
            _row("PAGO FACIL", "8880", "wide_master_simple", key="b"),
        ]
        self.assertTrue(self._check(rows, self._full()).ok)

    def _excess(self, rows):
        result = mod.reconcile_statement(
            self.SOURCE, {"currency": "clp"}, rows, self._full(), parse_clp, parse_usd, layout_text=self._full()
        )
        return next(c for c in result.checks if c.code == "operaciones_excess")

    def test_a_line_read_twice_fails(self) -> None:
        rows = [
            _row("TIENDA DEMO", "2217", "wide_master_simple", key="a"),
            _row("PAGO FACIL", "8880", "wide_master_simple", key="b"),
            _row("PAGO FACIL", "8880", "compact_de_simple", key="b#dup1"),
        ]
        check = self._excess(rows)
        self.assertFalse(check.ok)
        self.assertEqual(check.delta, 8880.0)
        self.assertTrue(self._check(rows, self._full()).ok)

    def test_a_refund_the_rules_set_aside_nets_back(self) -> None:
        rows = [
            _row("TIENDA DEMO", "2217", "wide_master_simple", key="a"),
            _row("PAGO FACIL", "8880", "wide_master_simple", key="b"),
            _row("TIENDA EXTRA", "1000", "wide_master_simple", key="c"),
            _row("DEVOLUCION TIENDA", "-1000", "wide_master_simple", key="d"),
        ]
        self.assertTrue(self._excess(rows).ok)
        self.assertTrue(self._check(rows, self._full()).ok)

    def test_an_ocr_scan_is_not_checked(self) -> None:
        flat = " ".join(self._full().split("\n")) + " " + "x" * 400
        result = mod.reconcile_statement(
            self.SOURCE,
            {"currency": "clp"},
            [_row("TIENDA DEMO", "2217", "wide_master_simple", key="a")],
            flat,
            parse_clp,
            parse_usd,
        )
        self.assertFalse(any(c.code in ("operaciones_shortfall", "operaciones_excess") for c in result.checks))



class BciOperacionesExcessTest(unittest.TestCase):
    """BCI's operaciones subtotal holds the parsed lines both ways (synthetic)."""

    SOURCE = "2036-08-26 eecc 4343.pdf"

    def _result(self, rows):
        return mod.reconcile_statement(self.SOURCE, {"currency": "clp"}, rows, BCI_RENDERING, parse_clp, parse_usd)

    def _rows(self):
        return [
            _row("TIENDA UNO (T)", "10000", "bci_lider_operaciones", key="a"),
            _row("TIENDA DOS (T)", "20000", "bci_lider_operaciones", key="b"),
            _row("SERVICIO TRES (T)", "70000", "bci_lider_operaciones", key="c"),
        ]

    def test_lines_over_the_subtotal_fail_inside_the_three_percent_band(self) -> None:
        result = self._result([*self._rows(), _row("TIENDA CUATRO (T)", "2000", "bci_lider_operaciones", key="d")])
        excess = next(c for c in result.checks if c.code == "operaciones_excess")
        self.assertFalse(excess.ok)
        self.assertEqual(excess.delta, 2000.0)
        self.assertTrue(next(c for c in result.checks if c.code == "operaciones").ok)

    def test_the_printed_lines_pass(self) -> None:
        self.assertTrue(next(c for c in self._result(self._rows()).checks if c.code == "operaciones_excess").ok)


class Section4CuotasTest(unittest.TestCase):
    """Section 4 prints the first cuota of each plan bought in the period (synthetic)."""

    SOURCE = "2036-08-24 estado de cuenta tarjeta 4141.pdf"
    FULL = "\n".join(
        [
            "MONTO PAGADO PERIODO ANTERIOR                              $ -79.928",
            "2. PERIODO ACTUAL",
            "1. TOTAL OPERACIONES                                       $ 2.217",
            "SANTIAGO        02/08/2036 TIENDA DEMO                     $ 2.217",
            "4. INFORMACION COMPRAS EN CUOTAS EN EL PERIODO             $ 30.000",
            "MONTO TOTAL FACTURADO A PAGAR                              $ 2.217",
        ]
    )

    def _plan(self, key: str) -> dict:
        return {
            **_row("PLAN DEMO", "90000", "wide_master_periodic_summary", key=key),
            "installment_flag": "true",
            "valor_cuota_mensual_clp": "30000",
            "nro_cuota_current": "",
            "nro_cuota_total": "3",
        }

    def _check(self, rows):
        result = mod.reconcile_statement(self.SOURCE, {"currency": "clp"}, rows, self.FULL, parse_clp, parse_usd, layout_text=self.FULL)
        return next(c for c in result.checks if c.code == "section4_cuotas")

    def test_the_announced_plan_matches(self) -> None:
        self.assertTrue(self._check([_row("TIENDA DEMO", "2217", "wide_master_simple", key="a"), self._plan("p")]).ok)

    def test_a_doubled_announcement_row_fails(self) -> None:
        check = self._check([_row("TIENDA DEMO", "2217", "wide_master_simple", key="a"), self._plan("p"), self._plan("p#dup1")])
        self.assertFalse(check.ok)
        self.assertEqual(check.delta, 30000.0)


class WithholdStatementsTest(unittest.TestCase):
    def test_a_withheld_statement_leaves_the_csv_and_the_manifest_the_others_stay(self) -> None:
        rows = [{"source_pdf": "a.pdf", "row_id": "1"}, {"source_pdf": "b.pdf", "row_id": "2"}, {"source_pdf": "c.pdf", "row_id": "3"}]
        entries = [
            {"pdf_sha256": "x", "parser_version": "v", "source_pdf": "a.pdf", "statement": "a.pdf"},
            {"pdf_sha256": "y", "parser_version": "v", "source_pdf": "b-file.pdf", "statement": "b.pdf"},
            {"pdf_sha256": "z", "parser_version": "v", "source_pdf": "c.pdf", "statement": "c.pdf"},
        ]
        kept_rows, kept_entries = mod.withhold_statements(rows, entries, {"b.pdf"})
        self.assertEqual([r["source_pdf"] for r in kept_rows], ["a.pdf", "c.pdf"])
        self.assertEqual([e["pdf_sha256"] for e in kept_entries], ["x", "z"])
        result = mod.ReconcileResult(source_pdf="b.pdf", currency="clp", ok=False, withheld=True)
        self.assertTrue(mod.reconcile_result_to_json(result)["withheld"])

    def test_a_reconcile_that_raises_withholds_only_its_statement_with_the_error(self) -> None:
        full = "MONTO TOTAL FACTURADO A PAGAR $ 2.217"
        rows = [_row("TIENDA DEMO", "2217", "", key="a")]
        result = mod.reconcile_statement_or_withhold("2036-08-24 estado de cuenta tarjeta 4141.pdf", {"currency": "clp"}, rows, full, parse_clp, parse_usd, layout_text=full)
        self.assertTrue(result.withheld)
        self.assertFalse(result.ok)
        self.assertEqual(result.skip_reason, "reconcile_error")
        self.assertIn("no parser layout", result.error)
        self.assertIn("no parser layout", mod.reconcile_result_to_json(result)["error"])


class RowIdCountTest(unittest.TestCase):
    def test_two_rows_sharing_a_dedupe_key_are_two_lines(self) -> None:
        # The import counts rows by row id; the parse check must too.
        a = {**_row("TIENDA DEMO", "2000", "wide_master_simple", key="r1"), "dedupe_key": "k"}
        b = {**_row("TIENDA DEMO", "2000", "compact_de_simple", key="r2"), "dedupe_key": "k"}
        sums = mod.sum_parsed_sections([a, b], parse_clp, parse_usd)
        self.assertEqual(sums["parsed_operaciones"], 4000)


class UsdTwinsAndPeriodBlockTest(unittest.TestCase):
    def test_affirmed_twins_count_same_day_same_dollars_repeat_does_not(self) -> None:
        twin = _row("APP STORE", "9,99", "international_usd", "usd", key="k1")
        twin["dedupe_key"] = "k1"
        twin2 = dict(twin, row_id="k2", dedupe_key="k1#dup1")
        repeat = dict(twin, row_id="k3", dedupe_key="k3")
        rows = mod._iter_reconcile_rows([twin, twin2, repeat])
        self.assertEqual([r["row_id"] for r in rows], ["k1", "k2"])

    def test_column_by_column_period_block_pairs_labels_with_values_in_order(self) -> None:
        text = "\n".join(
            [
                "1. INFORMACIÓN DEL PERÍODO",
                "SALDO ANTERIOR FACTURADO",
                "ABONO REALIZADO",
                "TOTAL DE COMPRAS Y CARGOS",
                "TRASPASO DEUDA NACIONAL",
                "DEUDA TOTAL",
                "US$ 500,00",
                "US$ -500,00",
                "US$ 42,10",
                "US$ 0,00",
                "US$ 42,10",
            ]
        )
        block = mod.usd_period_block_amounts(text, parse_usd)
        self.assertEqual(block["DEUDA TOTAL"], 42.10)
        self.assertEqual(block["SALDO ANTERIOR FACTURADO"], 500.0)
        self.assertEqual(block["ABONO REALIZADO"], -500.0)
        totals = mod.extract_pdf_section_totals(text, "usd", parse_clp, parse_usd)
        self.assertEqual(totals["pdf_deuda_total"], 42.10)
        self.assertEqual(totals["pdf_compras_cargos"], 42.10)

    def test_column_block_with_a_value_missing_pairs_nothing(self) -> None:
        text = "\n".join(
            [
                "SALDO ANTERIOR FACTURADO",
                "ABONO REALIZADO",
                "TOTAL DE COMPRAS Y CARGOS",
                "TRASPASO DEUDA NACIONAL",
                "DEUDA TOTAL",
                "US$ 500,00",
                "US$ -500,00",
                "US$ 42,10",
                "US$ 42,10",
                "2. INFORMACION DE TRANSACCIONES",
            ]
        )
        self.assertEqual(mod.usd_period_block_amounts(text, parse_usd), {})

    def test_row_by_row_period_block_is_left_to_the_label_regexes(self) -> None:
        text = "SALDO ANTERIOR FACTURADO\nUS$ 500,00\nABONO REALIZADO\nUS$ -500,00\nDEUDA TOTAL\nUS$ 42,10\n"
        self.assertEqual(mod.usd_period_block_amounts(text, parse_usd), {})
        totals = mod.extract_pdf_section_totals(text, "usd", parse_clp, parse_usd)
        self.assertEqual(totals["pdf_deuda_total"], 42.10)

if __name__ == "__main__":
    unittest.main()
