#!/usr/bin/env python3
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lider_login_failure import classify_login_failure  # noqa: E402


class ClassifyLoginFailureTest(unittest.TestCase):
    def test_generic_site_error_is_transient(self) -> None:
        text = "Ingresa a tu cuenta en línea Ha ocurrido un error Lo sentimos, el servicio no está disponible"
        self.assertEqual(classify_login_failure(text), "transient")

    def test_wrong_credential_phrasings(self) -> None:
        for text in (
            "Clave incorrecta",
            "Los datos ingresados son incorrectos",
            "RUT o CLAVE incorrectos. Intenta nuevamente",
            "Credenciales inválidas",
            "  La   CLAVE\nes incorrecta ",
        ):
            self.assertEqual(classify_login_failure(text), "wrong_clave", text)

    def test_empty_is_transient(self) -> None:
        self.assertEqual(classify_login_failure(""), "transient")
        self.assertEqual(classify_login_failure("   "), "transient")


if __name__ == "__main__":
    unittest.main()
