#!/usr/bin/env python3
"""Unit tests for CC PDF readability / qpdf helpers."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent / "cc_pdf_qpdf.py"
spec = importlib.util.spec_from_file_location("cc_pdf_qpdf", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cc_pdf_qpdf"] = mod
spec.loader.exec_module(mod)


class ReadableTextTest(unittest.TestCase):
    def test_clp_statement_marker(self) -> None:
        self.assertTrue(
            mod.is_readable_santander_cc_statement_text(
                "ESTADO DE CUENTA EN MONEDA NACIONAL DE TARJETA DE CRÉDITO\n"
                "FECHA ESTADO DE CUENTA\n23/03/2021\n"
            )
        )

    def test_intl_marker(self) -> None:
        self.assertTrue(
            mod.is_readable_santander_cc_statement_text(
                "ESTADO DE CUENTA INTERNACIONAL\nMONTO US$\n"
            )
        )

    def test_bci_lider_marker(self) -> None:
        self.assertTrue(
            mod.is_readable_bci_lider_statement_text(
                "BANCO DE CREDITO E INVERSIONES\nMONTO TOTAL FACTURADO\n"
                "PERIODO FACTURADO\n"
            )
        )

    def test_combined_readable(self) -> None:
        self.assertTrue(
            mod.is_readable_cc_statement_text(
                "BANCO DE CREDITO E INVERSIONES\nMONTO TOTAL FACTURADO\n"
            )
        )

    def test_garbled_not_readable(self) -> None:
        self.assertFalse(mod.is_readable_cc_statement_text('\t\x15\x16"#$&\n'))

    def test_too_short_not_readable(self) -> None:
        self.assertFalse(mod.is_readable_cc_statement_text("hello"))

    def test_peek_bci_lider_meta(self) -> None:
        iso, last4 = mod.peek_bci_lider_meta(
            "PERIODO FACTURADO HASTA 30/04/2024\n"
            "NUMERO TARJETA XXXXXXXXXX4343\n"
        )
        self.assertEqual(iso, "2024-04-30")
        self.assertEqual(last4, "4343")

    def test_password_env_names(self) -> None:
        self.assertEqual(
            mod.SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV,
            "SANTANDER_CC_STATEMENT_PDF_PASSWORD",
        )
        self.assertEqual(
            mod.LIDER_CC_STATEMENT_PDF_PASSWORD_ENV,
            "LIDER_CC_STATEMENT_PDF_PASSWORD",
        )

    def test_all_configured_passwords_dedupes(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                mod.SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV: "same",
                mod.LIDER_CC_STATEMENT_PDF_PASSWORD_ENV: "same",
            },
            clear=False,
        ):
            self.assertEqual(mod.all_configured_statement_pdf_passwords(), ["same"])

    def test_legacy_env_comma_separated_passwords(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                mod.SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV: "",
                mod.LIDER_CC_STATEMENT_PDF_PASSWORD_ENV: "",
                mod.LEGACY_CC_STATEMENT_PDF_PASSWORD_ENV: "first, second",
            },
            clear=False,
        ):
            self.assertEqual(
                mod.all_configured_statement_pdf_passwords(), ["first", "second"]
            )

    def test_inbox_attachment_prefers_lider_order(self) -> None:
        path = Path("/tmp/155028273.pdf")
        with mock.patch.dict(
            "os.environ",
            {
                mod.SANTANDER_CC_STATEMENT_PDF_PASSWORD_ENV: "s",
                mod.LIDER_CC_STATEMENT_PDF_PASSWORD_ENV: "l",
            },
            clear=False,
        ):
            order = mod.statement_pdf_passwords_to_try(path, "")
        self.assertEqual(order, ["l", "s"])

    def test_try_all_passwords_after_invalid(self) -> None:
        path = Path("/tmp/fake-cc.pdf")
        calls: list[str | None] = []

        def fake_decrypt(p: Path, password: str) -> tuple[bool, str]:
            calls.append(password)
            if password == "lider-pw":
                return True, "decrypted"
            return False, "qpdf: invalid password"

        with mock.patch.object(mod, "peek_pdf_text", return_value=""):
            with mock.patch.object(mod, "pdf_is_encrypted", return_value=True):
                with mock.patch.object(
                    mod, "is_readable_cc_statement_text", return_value=False
                ):
                    with mock.patch.object(
                        mod, "statement_pdf_passwords_to_try",
                        return_value=["santander-pw", "lider-pw"],
                    ):
                        with mock.patch.object(
                            mod,
                            "try_qpdf_decrypt_with_password",
                            side_effect=fake_decrypt,
                        ):
                            ok, msg = mod.try_qpdf_repair_with_all_passwords(path)
        self.assertTrue(ok)
        self.assertEqual(calls, ["santander-pw", "lider-pw"])
        self.assertEqual(msg, "decrypted")


if __name__ == "__main__":
    unittest.main()
