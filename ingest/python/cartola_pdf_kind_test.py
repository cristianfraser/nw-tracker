#!/usr/bin/env python3
"""Tests for checking vs cuenta vista cartola PDF classification."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "cartola_pdf_kind.py"
spec = importlib.util.spec_from_file_location("cartola_pdf_kind", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cartola_pdf_kind"] = mod
spec.loader.exec_module(mod)


VISTA_ZERO_ACTIVITY = """
ESTADO CUENTAMATICA
0-000-00-00002-2
CARTOLA 2 31/03/2021 30/04/2021
Saldo Inicial Cheques o Cargos Depósitos o Saldo Final
0 0 0 0
MOVIMIENTO DE SU CUENTA
"""

CHECKING_WITH_VISTA_TRANSFER = """
0323-M-C-00 10 31/10/2017 30/11/2017
0-000-00-01234-5
DETALLE DE MOVIMIENTOS
02/11 Agustinas Traspaso Internet de Cuenta Vista 500.000
"""


LINEA_CARTOLA = """
CTA CTE CREDITO
0-010-00-01234-5
0323-M-C-01 4 30/04/2024 28/01/2026
DETALLE DE MOVIMIENTOS
INFORMACION DE LA LINEA DE CREDITO
"""


# Synthetic `pdftotext -layout` headers of the cartolas mailed since October 2026 (made-up
# account numbers; column positions as the bank prints them).
NEW_CHECKING_ML = """
                                                                                     CUENTA CORRIENTE ML
         VITEST PERSON
                                                                                     0-000-00-01234-5 009 00000000
         vitest@example.com                                                          CARTOLA          DESDE             HASTA              PAGINA
                                                        0323-M-C-01
                                                                                        116          31/08/2026        30/09/2026          1 de 2
                              DETALLE DE MOVIMIENTOS                                                    SALDOS DIARIOS
"""

NEW_CHECKING_ME = """
                                                                               CUENTA CORRIENTE ME
     VITEST PERSON                                                             0-051-00-00000-1 012 00000000
     vitest@example.com                                                  CARTOLA         DESDE            HASTA           PAGINA
                                                 0323-M-C-01                  1           20/10/2024       30/10/2026        1 DE 1
                        DETALLE DE MOVIMIENTOS                                              SALDOS DIARIOS
"""

NEW_VISTA = """
                                                                                     CUENTAMATICA
   VITEST PERSON
                                                          0150-M-C-01
   ESTADO CUENTAMATICA                                                               CARTOLA         DESDE           HASTA              PAGINA
                0-070-00-00001-1                                                       88        31/08/2026 30/09/2026                1 DE 1
MOVIMIENTO DE SU CUENTA                                                                                    SALDO DIARIO
                                          ** CARTOLA SIN MOVIMIENTOS **
"""

NEW_CHECKING_NO_HEADER = """
                                                                                     CUENTA CORRIENTE ML
                                                                                     0-000-00-01234-5 009 00000000
                              DETALLE DE MOVIMIENTOS
01/09 Agustinas Traspaso a Cuenta de Otro Banco                     12.345                    987.654
"""


class CartolaPdfKindTest(unittest.TestCase):
    def test_vista_zero_activity(self) -> None:
        self.assertTrue(mod.is_cuenta_vista_cartola_text(VISTA_ZERO_ACTIVITY))
        self.assertFalse(mod.is_checking_cartola_text(VISTA_ZERO_ACTIVITY))

    def test_checking_not_vista_when_transfer_mentions_vista(self) -> None:
        self.assertFalse(mod.is_cuenta_vista_cartola_text(CHECKING_WITH_VISTA_TRANSFER))
        self.assertTrue(mod.is_checking_cartola_text(CHECKING_WITH_VISTA_TRANSFER))

    def test_linea_credito_not_checking(self) -> None:
        self.assertTrue(mod.is_linea_credito_cartola_text(LINEA_CARTOLA))
        self.assertFalse(mod.is_checking_cartola_text(LINEA_CARTOLA))

    def test_peek_hasta_and_no(self) -> None:
        hasta, no = mod.peek_cartola_hasta_and_no(CHECKING_WITH_VISTA_TRANSFER)
        self.assertEqual(hasta, "2017-11-30")
        self.assertEqual(no, "10")



class MailedCartolaClassificationTest(unittest.TestCase):
    def test_product_from_heading(self) -> None:
        self.assertEqual(mod.cartola_product(NEW_CHECKING_ML), mod.CARTOLA_PRODUCT_CHECKING)
        self.assertEqual(mod.cartola_product(NEW_CHECKING_ME), mod.CARTOLA_PRODUCT_CHECKING_FOREIGN)
        self.assertEqual(mod.cartola_product(NEW_VISTA), mod.CARTOLA_PRODUCT_CUENTA_VISTA)
        self.assertEqual(mod.cartola_product(LINEA_CARTOLA), mod.CARTOLA_PRODUCT_LINEA_CREDITO)
        self.assertIsNone(mod.cartola_product("ESTADO DE CUENTA NACIONAL DE TARJETA DE CREDITO"))

    def test_header_reads_number_and_printed_period(self) -> None:
        self.assertEqual(mod.peek_cartola_header(NEW_CHECKING_ML), ("116", "2026-08-31", "2026-09-30"))
        self.assertEqual(mod.peek_cartola_header(NEW_CHECKING_ME), ("1", "2024-10-20", "2026-10-30"))
        self.assertEqual(mod.peek_cartola_header(NEW_VISTA), ("88", "2026-08-31", "2026-09-30"))

    def test_header_missing_is_none_never_another_date(self) -> None:
        self.assertIsNone(mod.peek_cartola_header(NEW_CHECKING_NO_HEADER))

    def test_account_from_header(self) -> None:
        self.assertEqual(mod.peek_cartola_account(NEW_CHECKING_ME), "0-051-00-00000-1")
        self.assertEqual(mod.account_digits("0-000-00-01234-5"), "000000012345")

if __name__ == "__main__":
    unittest.main()
