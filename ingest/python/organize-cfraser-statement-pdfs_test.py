#!/usr/bin/env python3
"""Tests for Santander 80_* PDF organize (decrypt-then-classify, no size heuristics)."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Synthetic identifiers (never real account/contract numbers — see AGENTS.md fixtures
# convention). Written to a temp JSON and injected via NW_TRACKER_ORGANIZE_IDENTIFIERS
# before the module loads, so tests never depend on cfraser/organize-identifiers.json.
SYNTHETIC_IDENTIFIERS = {
    "santander_80_account_to_card_last4": {
        "0350300000000014141": "4141",
        "800000014141": "4141",
        "0350300000000014242": "4242",
        "800000014242": "4242",
    },
    "santander_checking_cartola_account": "000000012345",
    "santander_linea_credito_account": "001000012345",
}
_ids_file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
json.dump(SYNTHETIC_IDENTIFIERS, _ids_file)
_ids_file.close()
os.environ["NW_TRACKER_ORGANIZE_IDENTIFIERS"] = _ids_file.name
# Synthetic card registry too — the module imports cc_statement_pdf_paths → cc_cards.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[2] / "server" / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT = Path(__file__).resolve().parent / "organize-cfraser-statement-pdfs.py"
spec = importlib.util.spec_from_file_location("organize_pdfs", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["organize_pdfs"] = mod
spec.loader.exec_module(mod)


class Santander80FilenameTest(unittest.TestCase):
    def test_iso_from_filename(self) -> None:
        self.assertEqual(
            mod.iso_from_santander_80_filename(
                "80_356524_0350300000000014141_20201124.pdf"
            ),
            "2020-11-24",
        )
        self.assertEqual(
            mod.iso_from_santander_80_filename(
                "80_377457_0350300000000014141_20210222.pdf"
            ),
            "2021-02-22",
        )
        self.assertIsNone(mod.iso_from_santander_80_filename("cartola-65.pdf"))

    def test_cartola_attachment_dates(self) -> None:
        self.assertEqual(mod.iso_from_cartola_attachment_date("30042019"), "2019-04-30")
        self.assertEqual(mod.iso_from_cartola_attachment_date("20170831"), "2017-08-31")
        self.assertEqual(mod.iso_from_cartola_attachment_date("23072021"), "2021-07-23")

    def test_cc_suffix_maps_account_to_4141(self) -> None:
        self.assertEqual(
            mod.cc_suffix(
                "80_356524_0350300000000014141_20201124.pdf",
                None,
                None,
            ),
            "4141",
        )

    def test_checking_cartola_inbox_not_credit_card(self) -> None:
        name = "1_1054_000000012345_30042019_CC.pdf"
        self.assertTrue(mod.is_checking_cartola_inbox_name(name))
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "inbox"
            cart = Path(tmp) / "cartolas-cuenta-corriente"
            inbox.mkdir()
            pdf = inbox / name
            pdf.write_bytes(b"cartola")
            old_cfraser = mod.CFRASER
            old_cart = mod.CART_DIR
            old_resolve = mod.resolve_inbox_dir
            try:
                mod.CFRASER = Path(tmp)
                mod.CART_DIR = cart
                mod.resolve_inbox_dir = lambda: inbox
                moved = mod.organize_checking_cartolas_inbox(False)
                moved_cc, errors = mod.organize_credit_card(False, {})
            finally:
                mod.CFRASER = old_cfraser
                mod.CART_DIR = old_cart
                mod.resolve_inbox_dir = old_resolve
            self.assertEqual(moved, 1)
            self.assertEqual(errors, [])
            dest = cart / "2019-04-30 cartola cuenta corriente 1054.pdf"
            self.assertTrue(dest.is_file())
            self.assertFalse(pdf.exists())
            self.assertEqual(moved_cc, 0)

    def test_linea_credito_inbox_not_credit_card(self) -> None:
        name = "1_15149_001000012345_24122021_LC.pdf"
        self.assertTrue(mod.is_linea_credito_cartola_inbox_name(name))
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "inbox"
            linea = Path(tmp) / "cartolas-linea-credito"
            inbox.mkdir()
            pdf = inbox / name
            pdf.write_bytes(b"linea")
            old_resolve = mod.resolve_inbox_dir
            old_linea = mod.LINEA_DIR
            old_cfraser = mod.CFRASER
            try:
                mod.CFRASER = Path(tmp)
                mod.resolve_inbox_dir = lambda: inbox
                mod.LINEA_DIR = linea
                with mock.patch.object(
                    mod.subprocess,
                    "check_output",
                    return_value="CTA CTE CREDITO\n0323-M-C-01 4 30/04/2024 28/01/2026\n",
                ):
                    with mock.patch.object(
                        mod,
                        "peek_cartola_hasta_and_no",
                        return_value=("2026-01-28", "4"),
                    ):
                        moved_linea = mod.organize_linea_credito_cartolas_inbox(False)
                        moved_cc, errors = mod.organize_credit_card(False, {})
            finally:
                mod.resolve_inbox_dir = old_resolve
                mod.LINEA_DIR = old_linea
                mod.CFRASER = old_cfraser
            self.assertEqual(moved_linea, 1)
            self.assertEqual(errors, [])
            dest = linea / "2026-01-28 cartola linea credito 4.pdf"
            self.assertTrue(dest.is_file())
            self.assertFalse(pdf.exists())
            self.assertEqual(moved_cc, 0)

    def test_collision_skips_duplicate_without_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cc_root = Path(tmp) / "credit-card-statements"
            clp_dir = cc_root / "4141" / "clp"
            inbox = Path(tmp) / "inbox"
            clp_dir.mkdir(parents=True)
            inbox.mkdir()
            iso = "2021-09-22"
            clp_name = f"{iso} estado de cuenta tarjeta 4141.pdf"
            clp_path = clp_dir / clp_name
            clp_path.write_bytes(b"clp-statement")
            inbox_pdf = inbox / "80_2295_0350300000000014141_20210922.pdf"
            inbox_pdf.write_bytes(b"inbox-pdf")
            old_cc = mod.CC_DIR
            old_resolve = mod.resolve_inbox_dir
            old_cfraser = mod.CFRASER
            try:
                mod.CFRASER = Path(tmp)
                mod.CC_DIR = cc_root
                mod.resolve_inbox_dir = lambda: inbox
                with mock.patch.object(mod, "ensure_cc_pdf_readable", return_value=None):
                    with mock.patch.object(
                        mod,
                        "peek_meta",
                        return_value=(iso, False, "4141"),
                    ):
                        moved, errors = mod.organize_credit_card(False, {})
            finally:
                mod.CC_DIR = old_cc
                mod.resolve_inbox_dir = old_resolve
                mod.CFRASER = old_cfraser
            self.assertEqual(moved, 0)
            self.assertEqual(errors, [])
            dup = inbox / "duplicates" / inbox_pdf.name
            self.assertTrue(dup.is_file(), "inbox duplicate archived under inbox/duplicates/")
            self.assertFalse(inbox_pdf.exists())

    def test_usd_classified_from_pdf_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cc_root = Path(tmp) / "credit-card-statements"
            usd_dir = cc_root / "4141" / "usd"
            inbox = Path(tmp) / "inbox"
            usd_dir.mkdir(parents=True)
            inbox.mkdir()
            iso = "2021-09-22"
            inbox_pdf = inbox / "80_2295_0350300000000014141_20210922.pdf"
            inbox_pdf.write_bytes(b"usd-statement")
            old_cc = mod.CC_DIR
            old_resolve = mod.resolve_inbox_dir
            old_cfraser = mod.CFRASER
            try:
                mod.CFRASER = Path(tmp)
                mod.CC_DIR = cc_root
                mod.resolve_inbox_dir = lambda: inbox
                with mock.patch.object(mod, "ensure_cc_pdf_readable", return_value=None):
                    with mock.patch.object(
                        mod,
                        "peek_meta",
                        return_value=(iso, True, "4141"),
                    ):
                        moved, errors = mod.organize_credit_card(False, {})
            finally:
                mod.CC_DIR = old_cc
                mod.resolve_inbox_dir = old_resolve
                mod.CFRASER = old_cfraser
            usd_dest = usd_dir / f"{iso} estado de cuenta tarjeta usd 4141.pdf"
            self.assertEqual(errors, [])
            self.assertTrue(usd_dest.is_file())
            self.assertFalse(inbox_pdf.exists())
            self.assertGreaterEqual(moved, 1)

    def test_vista_sin_movimientos_replaced_by_incoming_with_movements(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vista = Path(tmp) / "cartolas-cuenta-vista"
            inbox = Path(tmp) / "inbox"
            vista.mkdir(parents=True)
            inbox.mkdir()
            dest = vista / "2024-04-30 cartola cuenta vista.pdf"
            dest.write_bytes(b"old-empty")
            incoming = inbox / "155028273.pdf"
            incoming.write_bytes(b"new-with-movements")
            old_vista = mod.VISTA_DIR
            old_resolve = mod.resolve_inbox_dir
            old_cfraser = mod.CFRASER
            try:
                mod.CFRASER = Path(tmp)
                mod.VISTA_DIR = vista
                mod.resolve_inbox_dir = lambda: inbox
                with mock.patch.object(
                    mod, "peek_cuenta_vista_meta", return_value=("2024-04-30", None)
                ):
                    with mock.patch.object(
                        mod,
                        "incoming_vista_cartola_replaces_dest",
                        side_effect=lambda existing, inc: existing == dest and inc == incoming,
                    ):
                        moved = mod.organize_cuenta_vista(False)
            finally:
                mod.VISTA_DIR = old_vista
                mod.resolve_inbox_dir = old_resolve
                mod.CFRASER = old_cfraser
            self.assertEqual(moved, 1)
            self.assertTrue(dest.is_file())
            self.assertFalse(incoming.exists())
            self.assertEqual(dest.read_bytes(), b"new-with-movements")



def _cartola_text(heading: str, account: str, number: str, desde: str, hasta: str) -> str:
    """Synthetic `pdftotext -layout` header of a cartola mailed since October 2026."""
    return (
        f"{' ' * 80}{heading}\n"
        "    VITEST PERSON\n"
        f"{' ' * 80}{account} 009 00000000\n"
        f"    vitest@example.com{' ' * 60}CARTOLA          DESDE             HASTA              PAGINA\n"
        f"{' ' * 56}0323-M-C-01\n"
        f"{' ' * 84}{number}          {desde}        {hasta}          1 de 1\n"
        "                    DETALLE DE MOVIMIENTOS                                   SALDOS DIARIOS\n"
    )


class MailedCartolaByTextTest(unittest.TestCase):
    """Attachment names without account or date (`LCA_CTA_CTE_CRONO-<n>_<m>.pdf`): the text decides."""

    def _run(self, files: dict[str, str], existing: dict[str, str] | None = None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        inbox = root / "inbox"
        inbox.mkdir()
        for name, text in files.items():
            (inbox / name).write_text(text, encoding="utf-8")
        for rel, text in (existing or {}).items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text, encoding="utf-8")
        patches = {
            "CFRASER": root,
            "CART_DIR": root / "cartolas-cuenta-corriente",
            "LINEA_DIR": root / "cartolas-linea-credito",
            "VISTA_DIR": root / "cartolas-cuenta-vista",
            "OTHER_ACCOUNTS_DIR": root / "cartolas-otras-cuentas",
            "CC_DIR": root / "credit-card-statements",
            "resolve_inbox_dir": lambda: inbox,
            "pdftotext_layout": lambda path: Path(path).read_text(encoding="utf-8"),
            "_CLAIMED_THIS_RUN": set(),
            "_UNTRACKED_PARKED": [],
            # Stored as digits: compared by digits with the printed `0-070-00-00009-9`.
            "IGNORED_CARTOLA_ACCOUNTS": {"007000000099"},
        }
        saved = {k: getattr(mod, k) for k in patches}
        for k, v in patches.items():
            setattr(mod, k, v)
        mod.reset_inbox_manifest()
        try:
            moved, errors = mod.organize_santander_cartolas_by_text(False)
            moved_cc, cc_errors = mod.organize_credit_card(False, {})
            manifest = {k: list(v) for k, v in mod._INBOX_MANIFEST.items()}
            parked = list(mod._UNTRACKED_PARKED)
        finally:
            for k, v in saved.items():
                setattr(mod, k, v)
        return root, inbox, moved, errors, moved_cc, cc_errors, manifest, parked

    def test_tracked_peso_checking_cartola_filed_under_its_printed_period(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ML", "0-000-00-01234-5", "116", "31/08/2026", "30/09/2026")
        root, inbox, moved, errors, moved_cc, cc_errors, manifest, _ = self._run(
            {"LCA_CTA_CTE_CRONO-11_444444.pdf": text}
        )
        self.assertEqual((moved, errors, moved_cc, cc_errors), (1, [], 0, []))
        dest = root / "cartolas-cuenta-corriente" / "2026-09-30 cartola cuenta corriente 116.pdf"
        self.assertTrue(dest.is_file())
        self.assertEqual(manifest["checking_pdfs"], ["cartolas-cuenta-corriente/2026-09-30 cartola cuenta corriente 116.pdf"])

    def test_dollar_checking_cartola_parked_and_reported_not_imported(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ME", "0-051-00-00000-1", "1", "20/10/2024", "30/10/2026")
        root, inbox, moved, errors, moved_cc, cc_errors, manifest, parked = self._run(
            {"LCA_CTA_CTE_CARABO-12_555555.pdf": text}
        )
        self.assertEqual((moved, errors, moved_cc, cc_errors), (1, [], 0, []))
        dest = root / "cartolas-otras-cuentas" / "2026-10-30 cartola cuenta corriente me 00000 1.pdf"
        self.assertTrue(dest.is_file())
        self.assertEqual(manifest["checking_pdfs"], [])
        self.assertEqual(len(parked), 1)
        self.assertFalse(list((root / "cartolas-cuenta-corriente").glob("*.pdf")) if (root / "cartolas-cuenta-corriente").is_dir() else [])

    def test_peso_checking_cartola_of_an_unknown_account_fails_and_stays(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ML", "0-000-00-05555-1", "7", "31/08/2026", "30/09/2026")
        root, inbox, moved, errors, _mcc, cc_errors, manifest, parked = self._run({"LCA_CTA_CTE_CRONO-1_1.pdf": text})
        self.assertEqual((moved, cc_errors, parked), (0, [], []))
        self.assertEqual(len(errors), 1)
        self.assertIn("·5551", errors[0])
        self.assertIn("santander_ignored_cartola_accounts", errors[0])
        self.assertNotIn("05555", errors[0])
        self.assertTrue((inbox / "LCA_CTA_CTE_CRONO-1_1.pdf").is_file())
        self.assertEqual(manifest["checking_pdfs"], [])

    def test_linea_credito_cartola_of_an_unknown_account_fails(self) -> None:
        text = _cartola_text("CTA CTE CREDITO", "0-010-00-09999-9", "4", "31/12/2025", "28/01/2026")
        _root, inbox, moved, errors, *_rest = self._run({"LCA_CTA_CTE_X-1_2.pdf": text})
        self.assertEqual(moved, 0)
        self.assertEqual(len(errors), 1)
        self.assertIn("santander_linea_credito_account", errors[0])
        self.assertTrue((inbox / "LCA_CTA_CTE_X-1_2.pdf").is_file())

    def test_linea_credito_already_filed_under_its_attachment_date_is_a_duplicate(self) -> None:
        text = _cartola_text("CTA CTE CREDITO", "0-010-00-01234-5", "4", "31/12/2025", "28/01/2026")
        root, inbox, moved, errors, *_rest = self._run(
            {"LCA_CTA_CTE_X-1_2.pdf": text},
            existing={"cartolas-linea-credito/2026-01-31 cartola linea credito 4.pdf": text},
        )
        self.assertEqual((moved, errors), (1, []))
        self.assertTrue((inbox / "duplicates" / "LCA_CTA_CTE_X-1_2.pdf").is_file())
        self.assertFalse((root / "cartolas-linea-credito" / "2026-01-28 cartola linea credito 4.pdf").exists())

    def test_fetcher_disambiguated_name_is_classified_by_text(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ML", "0-000-00-01234-5", "117", "30/09/2026", "30/10/2026")
        root, _inbox, moved, errors, *_rest = self._run({"2026-10-28_ab12cd34_LCA_CTA_CTE_CRONO-11_444444.pdf": text})
        self.assertEqual((moved, errors), (1, []))
        self.assertTrue((root / "cartolas-cuenta-corriente" / "2026-10-30 cartola cuenta corriente 117.pdf").is_file())

    def test_linea_credito_cartola_by_text(self) -> None:
        text = _cartola_text("CTA CTE CREDITO", "0-010-00-01234-5", "4", "31/12/2025", "28/01/2026")
        root, *_rest = self._run({"LCA_CTA_CTE_X-1_2.pdf": text})
        self.assertTrue((root / "cartolas-linea-credito" / "2026-01-28 cartola linea credito 4.pdf").is_file())

    def test_ignored_account_parked_as_before(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ML", "0-070-00-00009-9", "3", "31/08/2026", "30/09/2026")
        root, _inbox, moved, errors, *_rest = self._run({"LCA_CTA_CTE_CRONO-2_3.pdf": text})
        self.assertEqual((moved, errors), (1, []))
        self.assertTrue((root / "cartolas-otras-cuentas" / "2026-09-30 cartola cuenta 00009.pdf").is_file())

    def test_same_cartola_mailed_again_goes_to_inbox_duplicates(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ML", "0-000-00-01234-5", "116", "31/08/2026", "30/09/2026")
        root, inbox, moved, errors, _mcc, cc_errors, manifest, _ = self._run(
            {"LCA_CTA_CTE_CRONO-99_1.pdf": text},
            existing={"cartolas-cuenta-corriente/2026-09-30 cartola cuenta corriente 116.pdf": text},
        )
        self.assertEqual((moved, errors, cc_errors), (1, [], []))
        self.assertTrue((inbox / "duplicates" / "LCA_CTA_CTE_CRONO-99_1.pdf").is_file())
        self.assertEqual(manifest["checking_pdfs"], [])

    def test_cartola_without_printed_header_fails_loudly(self) -> None:
        text = (
            "CUENTA CORRIENTE ML\n0-000-00-01234-5\nDETALLE DE MOVIMIENTOS\n"
            "01/09 Agustinas Traspaso 12.345 987.654\n"
        )
        _root, inbox, moved, errors, _mcc, cc_errors, _m, _p = self._run({"LCA_CTA_CTE_CRONO-5_6.pdf": text})
        self.assertEqual(moved, 0)
        self.assertEqual(len(errors), 1)
        self.assertIn("header", errors[0])
        self.assertEqual(cc_errors, [], "the card pass does not refuse the same file a second time")
        self.assertTrue((inbox / "LCA_CTA_CTE_CRONO-5_6.pdf").is_file(), "left in the inbox")

    def test_old_name_left_to_the_name_based_pass(self) -> None:
        text = _cartola_text("CUENTA CORRIENTE ML", "0-000-00-01234-5", "116", "31/08/2026", "30/09/2026")
        _root, inbox, moved, errors, *_rest = self._run({"1_1054_000000012345_30092026_CC.pdf": text})
        self.assertEqual((moved, errors), (0, []))


class DecryptInboxTest(unittest.TestCase):
    def test_decrypts_only_what_pdftotext_cannot_open_and_never_on_a_dry_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp)
            (inbox / "TC_NAC-1_2.pdf").write_bytes(b"locked")
            (inbox / "readable.pdf").write_bytes(b"open")
            calls: list[tuple[str, str]] = []
            with mock.patch.object(mod, "resolve_inbox_dir", return_value=inbox), mock.patch.object(
                mod, "qpdf_available", return_value=True
            ), mock.patch.object(
                mod, "pdftotext_layout", side_effect=lambda p: None if Path(p).read_bytes() == b"locked" else "text"
            ), mock.patch.object(mod, "pdf_is_encrypted", return_value=True), mock.patch.object(
                mod, "statement_pdf_passwords_to_try", return_value=["wrong", "right"]
            ), mock.patch.object(
                mod,
                "try_qpdf_decrypt_with_password",
                side_effect=lambda p, pw: (calls.append((Path(p).name, pw)) or (pw == "right", "x")),
            ):
                self.assertEqual(mod.decrypt_inbox_pdfs(True), 0)
                self.assertEqual(calls, [])
                self.assertEqual(mod.decrypt_inbox_pdfs(False), 1)
            self.assertEqual(calls, [("TC_NAC-1_2.pdf", "wrong"), ("TC_NAC-1_2.pdf", "right")])


class VistaConfiguredAccountTest(unittest.TestCase):
    def _run(self, configured: str, printed: str):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        inbox = root / "inbox"
        inbox.mkdir()
        pdf = inbox / "C_MATICA_ONDEM-1_2.pdf"
        pdf.write_bytes(b"vista")
        patches = {
            "CFRASER": root,
            "VISTA_DIR": root / "cartolas-cuenta-vista",
            "OTHER_ACCOUNTS_DIR": root / "cartolas-otras-cuentas",
            "resolve_inbox_dir": lambda: inbox,
            "SANTANDER_CUENTA_VISTA_ACCOUNT": configured,
            "IGNORED_CARTOLA_ACCOUNTS": {"007000000099"},
            "_CLAIMED_THIS_RUN": set(),
            "_RUN_ERRORS": [],
        }
        saved = {k: getattr(mod, k) for k in patches}
        for k, v in patches.items():
            setattr(mod, k, v)
        try:
            with mock.patch.object(mod, "peek_cuenta_vista_meta", return_value=("2026-09-30", None)), mock.patch.object(
                mod, "peek_cartola_pdf_account", return_value=printed
            ):
                moved = mod.organize_cuenta_vista(False)
            errors = list(mod._RUN_ERRORS)
        finally:
            for k, v in saved.items():
                setattr(mod, k, v)
        return root, pdf, moved, errors

    def test_configured_vista_is_filed(self) -> None:
        root, pdf, moved, errors = self._run("007000000011", "0-070-00-00001-1")
        self.assertEqual((moved, errors), (1, []))
        self.assertTrue((root / "cartolas-cuenta-vista" / "2026-09-30 cartola cuenta vista.pdf").is_file())

    def test_other_vista_account_fails_and_stays_when_one_is_configured(self) -> None:
        _root, pdf, moved, errors = self._run("007000000011", "0-070-00-00005-5")
        self.assertEqual(moved, 0)
        self.assertEqual(len(errors), 1)
        self.assertIn("·0055", errors[0])
        self.assertTrue(pdf.is_file())

    def test_ignored_vista_compared_by_digits_is_parked(self) -> None:
        root, _pdf, moved, errors = self._run("007000000011", "0-070-00-00009-9")
        self.assertEqual((moved, errors), (1, []))
        self.assertTrue((root / "cartolas-otras-cuentas" / "2026-09-30 cartola cuenta 00009.pdf").is_file())

    def test_unconfigured_vista_keeps_todays_behaviour(self) -> None:
        root, _pdf, moved, errors = self._run("", "0-070-00-00005-5")
        self.assertEqual((moved, errors), (1, []))
        self.assertTrue((root / "cartolas-cuenta-vista" / "2026-09-30 cartola cuenta vista.pdf").is_file())

if __name__ == "__main__":
    unittest.main()
