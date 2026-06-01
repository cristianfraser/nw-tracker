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
0-070-64-91751-4
CARTOLA 2 31/03/2021 30/04/2021
Saldo Inicial Cheques o Cargos Depósitos o Saldo Final
0 0 0 0
MOVIMIENTO DE SU CUENTA
"""

CHECKING_WITH_VISTA_TRANSFER = """
0323-M-C-00 10 31/10/2017 30/11/2017
0-000-71-20626-2
DETALLE DE MOVIMIENTOS
02/11 Agustinas Traspaso Internet de Cuenta Vista 500.000
"""


LINEA_CARTOLA = """
CTA CTE CREDITO
0-010-12-57000-3
0323-M-C-01 4 30/04/2024 28/01/2026
DETALLE DE MOVIMIENTOS
INFORMACION DE LA LINEA DE CREDITO
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


if __name__ == "__main__":
    unittest.main()
