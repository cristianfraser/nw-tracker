#!/usr/bin/env python3
"""Tests for Santander 80_* PDF organize (decrypt-then-classify, no size heuristics)."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
                "80_356524_REDACTED_20201124.pdf"
            ),
            "2020-11-24",
        )
        self.assertEqual(
            mod.iso_from_santander_80_filename(
                "80_377457_REDACTED_20210222.pdf"
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
                "80_356524_REDACTED_20201124.pdf",
                None,
                None,
            ),
            "4141",
        )

    def test_checking_cartola_inbox_not_credit_card(self) -> None:
        name = "1_1054_REDACTED_30042019_CC.pdf"
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
        name = "1_15149_REDACTED_24122021_LC.pdf"
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
            inbox_pdf = inbox / "80_2295_REDACTED_20210922.pdf"
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
            self.assertTrue(inbox_pdf.is_file(), "inbox PDF kept when duplicate skipped")

    def test_usd_classified_from_pdf_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cc_root = Path(tmp) / "credit-card-statements"
            usd_dir = cc_root / "4141" / "usd"
            inbox = Path(tmp) / "inbox"
            usd_dir.mkdir(parents=True)
            inbox.mkdir()
            iso = "2021-09-22"
            inbox_pdf = inbox / "80_2295_REDACTED_20210922.pdf"
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


if __name__ == "__main__":
    unittest.main()
