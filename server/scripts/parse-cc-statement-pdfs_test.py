#!/usr/bin/env python3
"""Unit tests for wide Master installment line parsing."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "parse-cc-statement-pdfs.py"
REPO_ROOT = Path(__file__).resolve().parents[2]

spec = importlib.util.spec_from_file_location("parse_cc_pdfs", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["parse_cc_pdfs"] = mod
spec.loader.exec_module(mod)


def cc_statement_pdf(card: str, slot: str, name: str) -> Path:
    nested = REPO_ROOT / "cfraser" / "credit-card-statements" / card / slot / name
    if nested.is_file():
        return nested
    return REPO_ROOT / "cfraser" / "credit-card-statements" / name


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
        path = cc_statement_pdf(
            "4141", "usd", "2024-01-24 estado de cuenta tarjeta usd 4141.pdf"
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


class MultiCardLayoutBodyTest(unittest.TestCase):
    def test_dec_2024_4242_uses_layout_body(self) -> None:
        path = cc_statement_pdf(
            "4242", "clp", "2024-12-23 estado de cuenta tarjeta 4242.pdf"
        )
        if not path.is_file():
            self.skipTest("fixture PDF missing")
        _, pypdf = mod.extract_pdf_text(path, "compact")
        layout = mod.pdftotext_layout_full(path)
        body = mod.choose_clp_parse_body(pypdf, layout, "compact")
        self.assertIs(layout, body)
        rows = mod.parse_clp_document(body, "compact")
        self.assertGreaterEqual(len(rows), 108)
        impto = [r for r in rows if "IMPTO" in str(r.get("merchant", "")).upper()]
        self.assertEqual(sorted(int(r["amount_clp"]) for r in impto), [230, 237])

    def test_may_2026_4111_uses_pypdf_body(self) -> None:
        path = cc_statement_pdf(
            "4111", "clp", "2026-05-25 estado de cuenta tarjeta 4111.pdf"
        )
        if not path.is_file():
            self.skipTest("fixture PDF missing")
        _, pypdf = mod.extract_pdf_text(path, "compact")
        layout = mod.pdftotext_layout_full(path)
        body = mod.choose_clp_parse_body(pypdf, layout, "compact")
        self.assertIs(pypdf, body)
        rows = mod.parse_clp_document(body, "compact")
        self.assertGreaterEqual(len(rows), 55)

    def test_aug_2024_4141_uses_pypdf_body(self) -> None:
        path = cc_statement_pdf(
            "4141", "clp", "2024-08-23 estado de cuenta tarjeta 4141.pdf"
        )
        if not path.is_file():
            self.skipTest("fixture PDF missing")
        _, pypdf = mod.extract_pdf_text(path, "compact")
        layout = mod.pdftotext_layout_full(path)
        body = mod.choose_clp_parse_body(pypdf, layout, "compact")
        self.assertIs(pypdf, body)
        rows = mod.parse_clp_document(body, "compact")
        self.assertGreaterEqual(len(rows), 50)


class OriginCardLast4Test(unittest.TestCase):
    def test_additional_card_section_stamps_origin_card_last4(self) -> None:
        sample = (
            "Número tarjeta XXXX XXXX XXXX 4242\n"
            "FECHA ESTADO DE CUENTA 22/01/2025\n"
            "2. PERÍODO ACTUAL\n"
            "VITACURA 23/01/2025 PAYU *UBER EATS $ 17.484\n"
            "MOVIMIENTOS TARJETA XXXX-3670 $ 383.930\n"
            "SANTIAGO 22/01/2025 LONDON COFFEE ALCANTARA $ 3.150\n"
            "SANTIAGO 29/01/2025 RESTAURANT DON CARLOS $ 103.740\n"
        )
        rows = mod.parse_wide_document(sample)
        self.assertEqual(len(rows), 3)
        uber = next(r for r in rows if "UBER" in str(r.get("merchant", "")).upper())
        london = next(
            r for r in rows if "LONDON COFFEE" in str(r.get("merchant", "")).upper()
        )
        don = next(r for r in rows if "DON CARLOS" in str(r.get("merchant", "")).upper())
        self.assertEqual(uber.get("origin_card_last4"), "4242")
        self.assertEqual(london.get("origin_card_last4"), "3670")
        self.assertEqual(don.get("origin_card_last4"), "3670")

    def test_jan_2025_4242_pdf_has_additional_card_rows(self) -> None:
        path = cc_statement_pdf(
            "4242", "clp", "2025-01-22 estado de cuenta tarjeta 4242.pdf"
        )
        if not path.is_file():
            self.skipTest("fixture PDF missing")
        rows, _ctx = mod.parse_one_pdf("A", path, [])
        adicional = [r for r in rows if str(r.get("origin_card_last4") or "") == "3670"]
        self.assertGreater(len(adicional), 0)


class ClpParseFallbackTest(unittest.TestCase):
    def test_mar_2025_compact_falls_back_to_wide(self) -> None:
        path = cc_statement_pdf("4141", "clp", "2025-03-25 estado de cuenta tarjeta 4141.pdf")
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


class WideDeferredAmountTest(unittest.TestCase):
    def test_amount_on_next_line_after_date_merchant(self) -> None:
        text = (
            "04/11/2024 ALMACENES BILBAO\n"
            "$ 4.080\n"
            "07/11/2024 ALMACENES BILBAO\n"
            "$ 1.960\n"
        )
        rows = mod.parse_wide_document(text)
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(int(r["amount_clp"]) for r in rows), 4080 + 1960)

    def test_orphan_amount_before_date_merchant(self) -> None:
        text = "$ 2.660\n22/10/2024 ALMACENES BILBAO\n"
        rows = mod.parse_wide_document(text)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["amount_clp"], 2660)
        self.assertIn("BILBAO", rows[0]["merchant"])

    def test_continuation_amount_after_deferred_pair(self) -> None:
        text = (
            "26/10/2024 JUMBO ALTO LAS CONDES\n"
            "$ 49.482\n"
            "$ 770\n"
        )
        rows = mod.parse_wide_document(text)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["amount_clp"], 49482)
        self.assertEqual(rows[1]["amount_clp"], 770)

    def test_mcc_date_merchant_amount_on_one_line(self) -> None:
        line = "11001SANTIAG 22/10/2024 ALMACENES BILBAO $ 2.660"
        rows = mod.parse_wide_document(line + "\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["amount_clp"], 2660)
        self.assertEqual(rows[0]["merchant"], "ALMACENES BILBAO")
        self.assertEqual(rows[0]["place"], "11001SANTIAG")


class CompactJammedMccDateTest(unittest.TestCase):
    def test_pypdf_merged_yy_with_mcc_digits(self) -> None:
        """Regression: 13/05/25 + 11001SANTIAG → 13/05/2511001SANTIAG in pypdf."""
        line = "13/05/2511001SANTIAG $2.200ALMACENES BILBAO"
        row = mod.try_parse_compact_simple(line)
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["transaction_date"], "13/05/25")
        self.assertEqual(row["amount_clp"], 2200)
        self.assertEqual(row["merchant"], "ALMACENES BILBAO")

    def test_normalize_tx_date_keeps_real_four_digit_year(self) -> None:
        self.assertEqual(mod.normalize_tx_date("22/10/2024"), "22/10/2024")
        self.assertEqual(mod.normalize_tx_date("13/05/2511"), "13/05/25")


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


class SantanderClpSectionParseTest(unittest.TestCase):
    """Santander Worldmember CLP: section-aware compact + billing identity."""

    @classmethod
    def setUpClass(cls) -> None:
        spec_r = importlib.util.spec_from_file_location(
            "cc_statement_reconcile", SCRIPT.parent / "cc_statement_reconcile.py"
        )
        cls.recon = importlib.util.module_from_spec(spec_r)
        assert spec_r.loader is not None
        spec_r.loader.exec_module(cls.recon)

    def _parse_clp_statement(
        self, card: str, name: str
    ) -> tuple[Path, str, list[dict]]:
        pdf = cc_statement_pdf(card, "clp", name)
        if not pdf.is_file():
            self.skipTest(f"fixture PDF not in repo: {name}")
        _pages, full = mod.extract_pdf_text(pdf, "compact")
        layout = mod.pdftotext_layout_full(pdf)
        body = mod.choose_clp_parse_body(full, layout, "compact")
        rows = mod.parse_clp_document(
            full, "compact", movement_full=body, layout_full=layout
        )
        meta = mod.extract_meta(full, pdf.name)
        pagado_hdr = meta.get("pdf_monto_pagado_anterior") or meta.get(
            "statement_monto_pagado_anterior"
        )
        monto_hdr = meta.get("pdf_monto_facturado") or meta.get(
            "statement_monto_facturado"
        )
        monto_cap = (
            max(int(abs(int(monto_hdr)) * 1.3), 800_000)
            if monto_hdr is not None
            else None
        )
        if mod._santander_worldmember_clp_text(full):
            traspaso_abs: set[int] = set()
            pagado_abs = (
                abs(int(pagado_hdr)) if pagado_hdr is not None else None
            )
            seen_pay: set[str] = set()
            seen_traspaso: set[int] = set()
            filtered: list[dict] = []
            for pr in rows:
                merchant_u = str(pr.get("merchant") or "").upper()
                if "TRASPASO" in merchant_u and "DEUDA" in merchant_u:
                    amt_abs = abs(int(pr.get("amount_clp") or 0))
                    if amt_abs in seen_traspaso:
                        continue
                    seen_traspaso.add(amt_abs)
                if pr.get("layout") == "compact_payment_abono":
                    amt_abs = abs(int(pr.get("amount_clp") or 0))
                    if pagado_abs is not None and amt_abs == pagado_abs:
                        continue
                    if monto_cap is not None and amt_abs > monto_cap:
                        continue
                    if amt_abs in traspaso_abs:
                        continue
                    key = f"{pr.get('transaction_date')}|{amt_abs}"
                    if key in seen_pay:
                        continue
                    seen_pay.add(key)
                filtered.append(pr)
            rows = filtered
        return pdf, f"{full}\n{layout}", rows

    def test_may_2021_no_facturado_ghost_row(self) -> None:
        pdf, text, rows = self._parse_clp_statement(
            "4141", "2021-05-24 estado de cuenta tarjeta 4141.pdf"
        )
        totals = self.recon.extract_pdf_section_totals(
            text, "clp", mod.parse_clp_amount, mod.parse_usd_amount
        )
        monto = int(totals.get("pdf_monto_facturado") or 0)
        self.assertEqual(monto, 415_613)
        for row in rows:
            self.assertNotEqual(abs(int(row.get("amount_clp") or 0)), monto)
        meta = {"currency": "clp", "source_pdf": pdf.name}
        result = self.recon.reconcile_statement(
            pdf.name,
            meta,
            rows,
            text,
            mod.parse_clp_amount,
            mod.parse_usd_amount,
        )
        self.assertTrue(result.ok, result.mismatch_summary())

    def test_dec_2023_cargos_include_traspaso(self) -> None:
        _pdf, text, rows = self._parse_clp_statement(
            "4141", "2023-12-22 estado de cuenta tarjeta 4141.pdf"
        )
        sums = self.recon.sum_parsed_sections(
            rows, mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(sums["parsed_operaciones"], 1_002_505.0)
        self.assertEqual(sums["parsed_cargos_abonos"], 562_018.0)
        traspaso = [
            r
            for r in rows
            if "TRASPASO" in str(r.get("merchant") or "").upper()
            and "DEUDA" in str(r.get("merchant") or "").upper()
        ]
        self.assertEqual(len(traspaso), 1)
        self.assertEqual(int(traspaso[0]["amount_clp"]), 545_584)
        meta = {"currency": "clp"}
        result = self.recon.reconcile_statement(
            _pdf.name,
            meta,
            rows,
            text,
            mod.parse_clp_amount,
            mod.parse_usd_amount,
        )
        self.assertTrue(result.ok, result.mismatch_summary())

    def test_sep_2021_billing_identity(self) -> None:
        pdf, text, rows = self._parse_clp_statement(
            "4141", "2021-09-22 estado de cuenta tarjeta 4141.pdf"
        )
        meta = {"currency": "clp", "source_pdf": pdf.name}
        result = self.recon.reconcile_statement(
            pdf.name,
            meta,
            rows,
            text,
            mod.parse_clp_amount,
            mod.parse_usd_amount,
        )
        self.assertTrue(result.ok, result.mismatch_summary())

    def test_legacy_4113_billing_identity(self) -> None:
        pdf = REPO_ROOT / "cfraser" / "credit-card-statements" / "legacy" / "clp" / (
            "2017-09-22 estado de cuenta tarjeta 4113.pdf"
        )
        if not pdf.is_file():
            self.skipTest("legacy 4113 fixture not in repo")
        _pages, full = mod.extract_pdf_text(pdf, "compact")
        layout = mod.pdftotext_layout_full(pdf)
        body = mod.choose_clp_parse_body(full, layout, "compact")
        rows = mod.parse_clp_document(
            full, "compact", movement_full=body, layout_full=layout
        )
        text = f"{full}\n{layout}"
        meta = {"currency": "clp", "source_pdf": pdf.name}
        result = self.recon.reconcile_statement(
            pdf.name,
            meta,
            rows,
            text,
            mod.parse_clp_amount,
            mod.parse_usd_amount,
        )
        self.assertTrue(result.ok, result.mismatch_summary())
        totals = self.recon.extract_pdf_section_totals(
            text, "clp", mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(totals.get("pdf_monto_facturado"), 121_388.0)
        self.assertEqual(totals.get("pdf_monto_facturado_anterior"), 208_093.0)
        self.assertEqual(totals.get("pdf_monto_pagado_anterior"), -317_804.0)

    def test_cell_int_meta_float_not_scrambled(self) -> None:
        self.assertEqual(mod._cell_int(231099.0), 231099)
        self.assertEqual(mod.fmt_clp(mod._cell_int(231099.0)), "231099")


    def test_apr_2023_rolling_billing_identity(self) -> None:
        pdf, text, rows = self._parse_clp_statement(
            "4141", "2023-04-24 estado de cuenta tarjeta 4141.pdf"
        )
        totals = self.recon.extract_pdf_section_totals(
            text, "clp", mod.parse_clp_amount, mod.parse_usd_amount
        )
        self.assertEqual(totals.get("pdf_monto_facturado_anterior"), 715_173.0)
        self.assertEqual(totals.get("pdf_monto_pagado_anterior"), -1_007_817.0)
        roll = self.recon._clp_rolling_billed(
            totals,
            float(totals["pdf_total_operaciones"] or 0),
            float(totals.get("pdf_total_cargos_abonos") or 0),
        )
        self.assertEqual(roll, 950_440.0)
        meta = {"currency": "clp", "source_pdf": pdf.name}
        result = self.recon.reconcile_statement(
            pdf.name,
            meta,
            rows,
            text,
            mod.parse_clp_amount,
            mod.parse_usd_amount,
        )
        self.assertTrue(result.ok, result.mismatch_summary())

    def test_feb_2025_zero_activity_payment_echo_not_fatal(self) -> None:
        """Zero-activity month: prior-period payment echo in movimientos, no import rows."""
        pdf = cc_statement_pdf(
            "4141", "clp", "2025-02-24 estado de cuenta tarjeta 4141.pdf"
        )
        if not pdf.is_file():
            self.skipTest("fixture PDF not in repo")
        rows, ctx = mod.parse_one_pdf("4141", pdf, [])
        meta = ctx["meta"]
        self.assertEqual(len(rows), 0)
        self.assertTrue(mod.is_zero_activity_statement_meta(meta))
        result = self.recon.reconcile_statement(
            ctx["source_pdf"],
            meta,
            rows,
            ctx["full"],
            mod.parse_clp_amount,
            mod.parse_usd_amount,
            layout_text=ctx["layout"],
        )
        self.assertTrue(result.ok)
        self.assertEqual(result.skip_reason, "zero_rows")


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
        pdf = cc_statement_pdf(
            "4141", "usd", "2023-12-22 estado de cuenta tarjeta usd 4141.pdf"
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
        pdf = cc_statement_pdf("4141", "clp", "2023-12-22 estado de cuenta tarjeta 4141.pdf")
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


class IntlUsdCardLast4Test(unittest.TestCase):
    def test_line_broken_pan_after_tarjeta_label(self) -> None:
        sample = (
            "ESTADO DE CUENTA INTERNACIONAL DE TARJETA DE CRÉDITO\n"
            "NOMBRE DEL TITULAR\n"
            "CRISTIAN FRASER CARRANZA\n"
            "Nº DE TARJETA DE CRÉDITO 5218\n"
            "9210\n"
            "0445\n"
            "4113\n"
            "WORLDMEMBER MASTERCARD\n"
            "FECHA ESTADO DE CUENTA 24/01/2018\n"
        )
        self.assertEqual(mod.extract_card_last4(sample), "4113")
        meta = mod.extract_meta_international(sample, "2018-01-24 estado de cuenta tarjeta.pdf")
        self.assertEqual(meta.get("card_last4"), "4113")

    def test_masked_pan_still_works(self) -> None:
        sample = "Número tarjeta XXXX XXXX XXXX 4242\nFECHA ESTADO DE CUENTA 22/05/2025\n"
        self.assertEqual(mod.extract_card_last4(sample), "4242")


class IntlUsdPeriodMetaTest(unittest.TestCase):
    def test_corrupt_usd_4141_layout_period(self) -> None:
        root = Path(__file__).resolve().parent.parent.parent
        pdf = cc_statement_pdf(
            "4141", "usd", "2018-11-22 estado de cuenta tarjeta usd 4141-CORRUPT.pdf"
        )
        if not pdf.is_file():
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
        pdf = cc_statement_pdf("4242", "clp", "2025-05-22 estado de cuenta tarjeta 4242.pdf")
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
            pdf = cc_statement_pdf(
                "4343", "clp", "2026-03-27 estado de cuenta tarjeta 4343.pdf"
            )
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

    def test_parse_bci_jan_2026_4343_pdf(self) -> None:
        root = Path(__file__).resolve().parent.parent.parent
        pdf = cc_statement_pdf("4343", "clp", "2026-01-26 estado de cuenta tarjeta 4343.pdf")
        if not pdf.is_file():
            pdf = cc_statement_pdf("4343", "clp", "2026-01-27 estado de cuenta tarjeta 4343.pdf")
        if not pdf.is_file():
            self.skipTest("BCI Jan 2026 statement PDF not present")
        parser = mod.choose_parser(pdf)
        _pages, full = mod.extract_pdf_text(pdf, parser)
        meta = mod.extract_meta(full, pdf.name)
        mod.finalize_statement_meta(meta, pdf)
        if meta.get("period_to") != "26/01/2026":
            self.skipTest(f"not Jan 2026 billing period: period_to={meta.get('period_to')!r}")
        self.assertEqual(meta.get("statement_date"), "27/01/2026")
        self.assertEqual(
            mod.organized_cc_pdf_iso_prefix(meta, full),
            "2026-01-26",
        )
        self.assertEqual(
            mod.target_cc_pdf_filename(meta),
            "2026-01-26 estado de cuenta tarjeta 4343.pdf",
        )
        rows = mod.parse_clp_document(full, parser)
        merchants = {str(r.get("merchant") or "").upper() for r in rows}
        self.assertIn("ENEL (T)", merchants)
        self.assertIn("METROGAS PAT (T)", merchants)
        self.assertIn("ENTEL HOGAR (T)", merchants)
        pos = sorted(
            int(r["amount_clp"])
            for r in rows
            if int(r["amount_clp"]) > 0
        )
        self.assertEqual(sum(pos), 280_092 + 3_555)
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
        self.assertNotEqual(result.skip_reason, "incomplete_parse")

    def test_parse_bci_lider_merged_line_layout(self) -> None:
        """Regression: pypdf merges place+date without space (OTROS COMERCIOS)."""
        sample = (
            "2. Período Actual\n"
            "LIDER\n"
            "PROVIDENCIA 28/12/2025 EXPRESS LYON, SANTIAGO (T) $ 30.920\n"
            "LAS CONDES 02/01/2026EXPRESS ESTORIL, SANTIAGO (T) $ 43.287\n"
            "OTROS COMERCIOS\n"
            "SANTIAGO CL 20/01/2026ENEL (T) $ 47.798\n"
            "3. Cargos / Comisiones, Impuestos / Abonos\n"
            "27/01/2026 -50% DCTO COM ADM|MANTENCION (T) $ 3.555\n"
            "MONTO TOTAL FACTURADO $ 283.647\n"
        )
        rows = mod.parse_bci_lider_document(sample)
        merchants = {str(r.get("merchant") or "").upper() for r in rows}
        self.assertIn("ENEL (T)", merchants)
        self.assertEqual(
            sum(int(r["amount_clp"]) for r in rows if int(r["amount_clp"]) > 0),
            30_920 + 43_287 + 47_798 + 3_555,
        )


class IntlUsd4113Jan2018Test(unittest.TestCase):
    def test_usd_headers_and_operaciones_match_pdf(self) -> None:
        pdf = (
            REPO_ROOT
            / "cfraser"
            / "credit-card-statements"
            / "4113"
            / "usd"
            / "2018-01-24 estado de cuenta tarjeta usd 4113.pdf"
        )
        if not pdf.is_file():
            self.skipTest("4113 USD fixture not in repo")
        rows, ctx = mod.parse_one_pdf("A", pdf, [])
        meta = ctx["meta"]
        self.assertEqual(len(rows), 10)
        self.assertAlmostEqual(float(meta["statement_saldo_anterior"]), 35.29, places=2)
        self.assertAlmostEqual(float(meta["statement_abono"]), -68.39, places=2)
        self.assertAlmostEqual(float(meta["statement_compras_cargos"]), 94.66, places=2)
        self.assertAlmostEqual(float(meta["statement_deuda_total"]), 61.56, places=2)
        pos = sum(
            float(str(r.get("amount_usd") or "0").replace(",", "."))
            for r in rows
            if float(str(r.get("amount_usd") or "0").replace(",", ".")) > 0
        )
        self.assertAlmostEqual(pos, 94.66, places=2)


class UnreadablePdfSkipTest(unittest.TestCase):
    def test_is_unreadable_pdf_error(self) -> None:
        self.assertTrue(
            mod.is_unreadable_pdf_error(
                "repaired (rewritten) but text still unreadable — re-download"
            )
        )
        self.assertTrue(mod.is_unreadable_pdf_error("unreadable PDF and qpdf not installed"))
        self.assertFalse(mod.is_unreadable_pdf_error("KeyError: 'period_to'"))


if __name__ == "__main__":
    unittest.main()
