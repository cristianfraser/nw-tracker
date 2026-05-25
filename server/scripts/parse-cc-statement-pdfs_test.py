#!/usr/bin/env python3
"""Unit tests for wide Master installment line parsing."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "parse-cc-statement-pdfs.py"
spec = importlib.util.spec_from_file_location("parse_cc_pdfs", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["parse_cc_pdfs"] = mod
spec.loader.exec_module(mod)


class IntlUsdAmountAssignmentTest(unittest.TestCase):
    def test_huf_orig_larger_than_usd_column(self) -> None:
        orig, usd = mod._assign_intl_orig_and_usd_amounts(["990,00", "3,39"])
        self.assertEqual(orig, "990,00")
        self.assertEqual(usd, "3,39")

    def test_huf_vertical_chunk_uses_usd_column(self) -> None:
        row = mod._parse_international_vertical_chunk(
            ["PAVILON BAR", "BUDAPEST", "HU", "990,00", "3,39"],
            "12/09/2021",
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertAlmostEqual(row["amount_usd"], 3.39)
        self.assertAlmostEqual(row["amount_orig"], 990.0)
        self.assertIn("PAVILON BAR", row["merchant"])

    def test_eur_similar_magnitudes_keep_table_order(self) -> None:
        orig, usd = mod._assign_intl_orig_and_usd_amounts(["173,00", "208,46"])
        self.assertEqual(orig, "173,00")
        self.assertEqual(usd, "208,46")

    def test_last_column_is_usd_dublin_ir(self) -> None:
        orig, usd = mod._assign_intl_orig_and_usd_amounts(["700,00", "2,40"])
        self.assertEqual(orig, "700,00")
        self.assertEqual(usd, "2,40")
        orig2, usd2 = mod._assign_intl_orig_and_usd_amounts(["375,00", "1,28"])
        self.assertEqual(orig2, "375,00")
        self.assertEqual(usd2, "1,28")

    def test_lone_large_amount_is_orig_not_usd(self) -> None:
        orig, usd = mod._assign_intl_orig_and_usd_amounts(["700,00"])
        self.assertEqual(orig, "700,00")
        self.assertEqual(usd, "")

    def test_dublin_vertical_two_amounts(self) -> None:
        row = mod._parse_international_vertical_chunk(
            ["LIM*RIDE COST", "DUBLIN", "IR", "800,00", "2,75"],
            "15/09/2021",
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertAlmostEqual(row["amount_usd"], 2.75)
        self.assertAlmostEqual(row["amount_orig"], 800.0)

    def test_intl_merge_layout_wins_over_wrong_vertical(self) -> None:
        layout = {
            "transaction_date": "13/09/2021",
            "merchant": "LIM*RIDE COST",
            "place": "DUBLIN",
            "country": "IR",
            "amount_usd": 2.4,
            "amount_orig": 700.0,
        }
        vertical_bad = {
            "transaction_date": "13/09/2021",
            "merchant": "LIM*RIDE COST DUBLIN",
            "place": "",
            "country": "IR",
            "amount_usd": 700.0,
            "amount_orig": None,
        }
        self.assertNotEqual(
            mod._intl_row_merge_key(layout),
            mod._intl_row_merge_key(vertical_bad),
        )
        merged = mod._merge_intl_parsed_rows([vertical_bad], [layout])
        self.assertEqual(len(merged), 1)
        self.assertAlmostEqual(merged[0]["amount_usd"], 2.4)
        self.assertAlmostEqual(merged[0]["amount_orig"], 700.0)

    def test_easyjet_layout_and_vertical_merge_once(self) -> None:
        layout = {
            "transaction_date": "02/10/2021",
            "merchant": "EASYJET000K2K1TJ4",
            "place": "LUTON, BEDS",
            "country": "GB",
            "amount_usd": 167.31,
            "amount_orig": 142.47,
        }
        vertical = {
            "transaction_date": "02/10/2021",
            "merchant": "EASYJET000K2K1TJ4 LUTON, BEDS",
            "place": "",
            "country": "GB",
            "amount_usd": 167.31,
            "amount_orig": 142.47,
        }
        self.assertEqual(
            mod._intl_merchant_core(layout["merchant"], layout["place"]),
            mod._intl_merchant_core(vertical["merchant"], vertical["place"]),
        )
        merged = mod._merge_intl_parsed_rows([vertical], [layout])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["merchant"], "EASYJET000K2K1TJ4")
        self.assertEqual(merged[0]["place"], "LUTON, BEDS")

    def test_brazil_row_strips_ch_footer_saldo(self) -> None:
        chunk = [
            "MERC ESTRELA DA MANHA",
            "MORRO DE SAO",
            "BR",
            "13,00",
            "2,41",
            "CH",
            "3.000,00",
        ]
        row = mod._parse_international_vertical_chunk(chunk, "19/10/2021")
        self.assertIsNotNone(row)
        assert row is not None
        self.assertAlmostEqual(row["amount_usd"], 2.41)
        self.assertAlmostEqual(row["amount_orig"], 13.0)
        self.assertEqual(row["country"], "BR")
        self.assertEqual(row["orig_currency"], "BRL")

    def test_same_day_two_rides_distinct_keys(self) -> None:
        a = {
            "transaction_date": "15/09/2021",
            "merchant": "LIM*RIDE COST",
            "place": "DUBLIN",
            "country": "IR",
            "amount_usd": 1.28,
            "amount_orig": 375.0,
        }
        b = {
            "transaction_date": "15/09/2021",
            "merchant": "LIM*RIDE COST",
            "place": "DUBLIN",
            "country": "IR",
            "amount_usd": 2.75,
            "amount_orig": 800.0,
        }
        self.assertNotEqual(mod._intl_row_merge_key(a), mod._intl_row_merge_key(b))


class IntlUsdLayout2024Test(unittest.TestCase):
    def test_normalize_spaced_statement_date(self) -> None:
        self.assertEqual(mod.normalize_statement_date("24 /01/2024"), "24/01/2024")
        self.assertEqual(
            mod.statement_date_from_source_pdf("2024-01-24 estado de cuenta tarjeta usd 4141.pdf"),
            "24/01/2024",
        )

    def test_footer_emisor_cliente_suffix_stripped(self) -> None:
        row = mod._build_intl_row(
            "17/01/2024",
            "ABONO DE DIVISAS EMISOR CLIENTE",
            "CH",
            "-21,00",
            "-21,28",
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["merchant"], "ABONO DE DIVISAS")

    def test_table_header_merchant_noise(self) -> None:
        self.assertTrue(
            mod._intl_merchant_is_noise("DESCRIPCIÓN OPERACIÓN O COBRO CIUDAD PAÍS")
        )

    def test_jan_2024_usd_sidecar_parses_table_rows(self) -> None:
        path = (
            Path(__file__).resolve().parent.parent
            / "cfraser/credit-card-statements/2024-01-24 estado de cuenta tarjeta usd 4141.pdf"
        )
        if not path.is_file():
            self.skipTest("fixture PDF missing")
        import subprocess

        full = subprocess.check_output(["pdftotext", str(path), "-"], text=True)
        layout = subprocess.check_output(["pdftotext", "-layout", str(path), "-"], text=True)
        rows = mod.parse_international_usd_document(full, layout)
        self.assertGreaterEqual(len(rows), 5)
        merchants = {r["merchant"] for r in rows}
        self.assertTrue(any("APPLE" in m for m in merchants))


class ClpParseFallbackTest(unittest.TestCase):
    def test_mar_2025_compact_falls_back_to_wide(self) -> None:
        path = (
            Path(__file__).resolve().parent.parent
            / "cfraser/credit-card-statements/2025-03-25 estado de cuenta tarjeta 4141.pdf"
        )
        if not path.is_file():
            self.skipTest("fixture PDF missing")
        _, full = mod.extract_pdf_text(path, "compact")
        rows = mod.parse_clp_document(full, "compact")
        self.assertGreaterEqual(len(rows), 2)
        merchants = " ".join(r["merchant"] for r in rows)
        self.assertIn("MCDONALD", merchants.upper())


class RowDedupeKeyTest(unittest.TestCase):
    def test_installment_key_includes_cuota_index(self) -> None:
        base = {
            "merchant": "PARIS INTERNET TCOM 2",
            "monto_total_a_pagar_clp": 259491,
            "nro_cuota_total": 3,
            "transaction_date": "22/02/2023",
            "valor_cuota_mensual_clp": 86497,
            "installment_flag": True,
        }
        a = {**base, "nro_cuota_current": 1}
        b = {**base, "nro_cuota_current": 2}
        self.assertNotEqual(mod.row_dedupe_key("santander", a), mod.row_dedupe_key("santander", b))

    def test_one_shot_key_stable_across_two_digit_and_four_digit_year(self) -> None:
        base = {
            "merchant": "LOS BRAVOS SPA",
            "amount_clp": "38830",
            "installment_flag": False,
        }
        a = {**base, "transaction_date": "29/03/25"}
        b = {**base, "transaction_date": "29/03/2025"}
        self.assertEqual(mod.row_dedupe_key("santander", a), mod.row_dedupe_key("santander", b))


class WideCuotaFijaTest(unittest.TestCase):
    def test_cuota_fija_parsed_as_installment(self) -> None:
        line = (
            "08/11/2023 FLOW   *COMUNIDAD VICT CUOTA FIJA 3,09 % "
            "$ 295.141 $ 323.698 02/03 $ 107.900"
        )
        rows = mod.parse_wide_document(line + "\n")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertTrue(r["installment_flag"])
        self.assertEqual(r["nro_cuota_current"], 2)
        self.assertEqual(r["nro_cuota_total"], 3)
        self.assertEqual(r["valor_cuota_mensual_clp"], 107900)
        self.assertEqual(r["amount_clp"], 295141)
        self.assertEqual(r["monto_total_a_pagar_clp"], 323698)
        self.assertEqual(r["tipo_cuota"], "CUOTA FIJA")
        self.assertIn("COMUNIDAD VICT", r["merchant"])
        self.assertNotIn("CUOTA FIJA", r["merchant"].upper())


class WideTcomCuotasTasaTest(unittest.TestCase):
    def test_tcom_cuotas_tasa_parsed_as_installment(self) -> None:
        line = (
            "22/02/2023 PARIS INTERNET TCOM 2 03 CUOTAS, TASA 3,01 % "
            "$ 233.980 $ 259.491 $ 86.497"
        )
        rows = mod.parse_wide_document(line + "\n")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertTrue(r["installment_flag"])
        self.assertEqual(r["layout"], "wide_master_tcom_cuotas_tasa")
        self.assertEqual(r["merchant"], "PARIS INTERNET TCOM 2")
        self.assertEqual(r["amount_clp"], 233980)
        self.assertEqual(r["monto_total_a_pagar_clp"], 259491)
        self.assertEqual(r["valor_cuota_mensual_clp"], 86497)
        self.assertEqual(r["nro_cuota_total"], 3)
        self.assertEqual(r["nro_cuota_current"], "")
        self.assertEqual(r["tipo_cuota"], "03 CUOTAS TCOM")
        self.assertEqual(r["interest_rate_text"], "3,01 %")


class StatementReconcileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        spec_r = importlib.util.spec_from_file_location(
            "cc_statement_reconcile", SCRIPT.parent / "cc_statement_reconcile.py"
        )
        cls.recon = importlib.util.module_from_spec(spec_r)
        assert spec_r.loader is not None
        spec_r.loader.exec_module(cls.recon)

    def test_extract_usd_section_totals_dec_2023(self) -> None:
        pdf = (
            SCRIPT.parent.parent.parent
            / "cfraser/credit-card-statements/2023-12-22 estado de cuenta tarjeta usd 4141.pdf"
        )
        if not pdf.is_file():
            self.skipTest("fixture PDF not in repo")
        import subprocess

        full = subprocess.check_output(["pdftotext", str(pdf), "-"], text=True)
        totals = self.recon.extract_pdf_section_totals(
            full, "usd", mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertAlmostEqual(totals["pdf_total_operaciones"] or 0, 2311.85, places=2)
        self.assertAlmostEqual(totals["pdf_total_cargos_abonos"] or 0, -1215.72, places=2)
        self.assertAlmostEqual(totals["pdf_deuda_total"] or 0, 1701.85, places=2)
        self.assertAlmostEqual(totals["pdf_compras_cargos"] or 0, 2311.85, places=2)

    def test_extract_clp_section_totals_dec_2023(self) -> None:
        pdf = (
            SCRIPT.parent.parent.parent
            / "cfraser/credit-card-statements/2023-12-22 estado de cuenta tarjeta 4141.pdf"
        )
        if not pdf.is_file():
            self.skipTest("fixture PDF not in repo")
        import subprocess

        full = subprocess.check_output(["pdftotext", "-layout", str(pdf), "-"], text=True)
        totals = self.recon.extract_pdf_section_totals(
            full, "clp", mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(totals["pdf_total_operaciones"], 1002505.0)
        self.assertEqual(totals["pdf_total_cargos_abonos"], 562018.0)
        self.assertEqual(totals["pdf_total_cuotas"], 48463.0)
        self.assertEqual(totals["pdf_monto_facturado"], 1563534.0)

    def test_classify_payment_vs_purchase(self) -> None:
        rows = [
            {
                "currency": "clp",
                "installment_flag": "false",
                "merchant": "EXPRESS MERCED",
                "amount_clp": "25000",
                "amount_usd": "",
                "valor_cuota_mensual_clp": "",
                "is_duplicate_across_statements": "false",
                "parser_layout": "wide_master_simple",
            },
            {
                "currency": "clp",
                "installment_flag": "false",
                "merchant": "MONTO CANCELADO",
                "amount_clp": "-1530000",
                "amount_usd": "",
                "valor_cuota_mensual_clp": "",
                "is_duplicate_across_statements": "false",
                "parser_layout": "wide_master_date_first",
            },
        ]
        sums = self.recon.sum_parsed_sections(
            rows, mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(sums["parsed_operaciones"], 25000.0)
        self.assertEqual(sums["parsed_cargos_abonos"], 0.0)

    def test_tcom_installment_excluded_from_operaciones(self) -> None:
        rows = [
            {
                "currency": "clp",
                "installment_flag": "true",
                "merchant": "PARIS INTERNET TCOM 2",
                "amount_clp": "233980",
                "valor_cuota_mensual_clp": "86497",
                "nro_cuota_current": "",
                "nro_cuota_total": "3",
                "is_duplicate_across_statements": "false",
                "parser_layout": "wide_master_tcom_cuotas_tasa",
            },
            {
                "currency": "clp",
                "installment_flag": "true",
                "merchant": "SERVITECA DACSA",
                "amount_clp": "340600",
                "valor_cuota_mensual_clp": "113533",
                "nro_cuota_current": "1",
                "nro_cuota_total": "3",
                "is_duplicate_across_statements": "false",
                "parser_layout": "wide_master_precio_summary",
            },
        ]
        sums = self.recon.sum_parsed_sections(
            rows, mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(sums["parsed_operaciones"], 113533.0)
        self.assertEqual(sums["parsed_cuotas"], 200030.0)

    def test_usd_payment_lines_excluded_from_cargos(self) -> None:
        rows = [
            {
                "currency": "usd",
                "installment_flag": "false",
                "merchant": "MONTO CANCELADO",
                "amount_usd": "-3050,00",
                "amount_clp": "",
                "country": "CH",
                "is_duplicate_across_statements": "false",
                "parser_layout": "international_usd",
            },
            {
                "currency": "usd",
                "installment_flag": "false",
                "merchant": "ABONO DE DIVISAS",
                "amount_usd": "-8,12",
                "amount_clp": "",
                "country": "CH",
                "is_duplicate_across_statements": "false",
                "parser_layout": "international_usd",
            },
        ]
        sums = self.recon.sum_parsed_sections(
            rows, mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(sums["parsed_cargos_abonos"], -8.12)

    def test_cross_statement_duplicate_still_counts_in_reconcile(self) -> None:
        rows = [
            {
                "currency": "usd",
                "installment_flag": "false",
                "merchant": "ABONO DE DIVISAS",
                "amount_usd": "-249,86",
                "is_duplicate_across_statements": "true",
                "parser_layout": "international_usd",
            },
        ]
        sums = self.recon.sum_parsed_sections(
            rows, mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(sums["parsed_cargos_abonos"], -249.86)


class ParseCacheTest(unittest.TestCase):
    def test_cache_hit_after_save(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "sample.pdf"
            pdf.write_bytes(b"%PDF-1.4 minimal")
            version = mod.parser_cache_version()
            mod.save_parse_cache(
                pdf,
                version,
                {
                    "source_pdf": pdf.name,
                    "card_group": "A",
                    "effective_group": "A",
                    "parser": "compact",
                    "meta": {"statement_date": "01/01/2024", "card_last4": "1234"},
                    "parsed": [],
                    "full": "",
                    "layout": "",
                },
            )
            loaded = mod.load_parse_cache(pdf, version)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded.get("card_group"), "A")
            self.assertIsNone(mod.load_parse_cache(pdf, "deadbeef00000000"))


class IntlUsdPeriodMetaTest(unittest.TestCase):
    def test_corrupt_usd_4141_layout_period(self) -> None:
        root = Path(__file__).resolve().parent.parent.parent
        pdf = root / "cfraser/credit-card-statements/2018-11-22 estado de cuenta tarjeta usd 4141-CORRUPT.pdf"
        if not pdf.is_file():
            self.skipTest("2018-11 USD 4141 CORRUPT PDF not present")
        _rows, ctx = mod.parse_one_pdf("INTL", pdf, [])
        meta = ctx["meta"]
        self.assertEqual(meta.get("period_from"), "22/10/2018")
        self.assertEqual(meta.get("period_to"), "22/11/2018")
        self.assertTrue(_rows)
        self.assertEqual(_rows[0].get("source_pdf"), "2018-11-22 estado de cuenta tarjeta usd 4141.pdf")


class SantanderStatementMetaTest(unittest.TestCase):
    def test_may_2025_4242_period_from_layout(self) -> None:
        root = Path(__file__).resolve().parent.parent.parent
        pdf = root / "cfraser/credit-card-statements/2025-05-22 estado de cuenta tarjeta 4242.pdf"
        if not pdf.is_file():
            self.skipTest("2025-05-22 4242 PDF not present")
        _rows, ctx = mod.parse_one_pdf("A", pdf, [])
        meta = ctx["meta"]
        self.assertEqual(meta.get("statement_date"), "22/05/2025")
        self.assertEqual(meta.get("period_from"), "22/04/2025")
        self.assertEqual(meta.get("period_to"), "22/05/2025")
        self.assertEqual(meta.get("pay_by"), "10/06/2025")


class BciLiderStatementTest(unittest.TestCase):
    def test_detect_bci_lider(self) -> None:
        sample = (
            "ESTADO DE CUENTA TARJETA DE CRÉDITO\n"
            "Número tarjeta XXXXXXXXXXXX4343\n"
            "Período Facturado 27/03/2026 26/04/2026\n"
            "Número tarjeta XXXXXXXXXXXX4343\n"
            "1. Total Operaciones\n"
            "MONTO TOTAL FACTURADO\n"
        )
        self.assertTrue(mod.is_bci_lider_statement_text(sample))
        self.assertFalse(mod.is_bci_lider_statement_text("MONTO ORIGEN OPERAC VALOR CUOTA"))

    def test_parse_bci_april_2026_pdf(self) -> None:
        root = Path(__file__).resolve().parent.parent.parent
        pdf = root / "cfraser/pdfs/EECC abril 2026.pdf"
        if not pdf.is_file():
            pdf = root / "cfraser/credit-card-statements/2026-03-27 estado de cuenta tarjeta 4343.pdf"
        if not pdf.is_file():
            self.skipTest("BCI statement PDF not present")
        parser = mod.choose_parser(pdf)
        _pages, full = mod.extract_pdf_text(pdf, parser)
        self.assertTrue(mod.is_bci_lider_statement_text(full))
        meta = mod.extract_meta(full, pdf.name)
        self.assertEqual(meta.get("card_last4"), "4343")
        self.assertEqual(meta.get("statement_date"), "27/04/2026")
        rows = mod.parse_clp_document(full, parser)
        self.assertGreaterEqual(len(rows), 6)
        amounts = sorted(
            int(r["amount_clp"])
            for r in rows
            if r.get("amount_clp") is not None and int(r["amount_clp"]) > 0
        )
        self.assertEqual(sum(amounts), 202284 + 3587)
        recon_path = Path(__file__).resolve().parent / "cc_statement_reconcile.py"
        spec = importlib.util.spec_from_file_location("cc_statement_reconcile", recon_path)
        assert spec and spec.loader
        recon_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recon_mod)
        emitted = [
            {
                "amount_clp": str(r["amount_clp"]),
                "merchant": r.get("merchant", ""),
                "installment_flag": "false",
                "parser_layout": r.get("layout", ""),
                "currency": "clp",
            }
            for r in rows
        ]
        result = recon_mod.reconcile_statement(
            pdf.name,
            meta,
            emitted,
            full,
            mod.parse_clp_amount,
            mod.parse_usd_amount,
        )
        self.assertTrue(result.ok, result.mismatch_summary())


if __name__ == "__main__":
    unittest.main()
