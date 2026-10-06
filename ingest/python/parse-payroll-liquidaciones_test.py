"""Tests for payroll liquidación parsing.

The ``test_*`` functions read personal OCR scans and skip without them; ``HeaderColumnTest``
is synthetic and runs anywhere:
  python3 ingest/python/parse-payroll-liquidaciones_test.py
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / ".pdf_deps"))

spec = importlib.util.spec_from_file_location(
    "parse_payroll_liquidaciones",
    SCRIPT_DIR / "parse-payroll-liquidaciones.py",
)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

CFRASER = SCRIPT_DIR.parent.parent / "cfraser"


def test_unholster_scan_april_2018_liquido():
    path = CFRASER / "liquidaciones/2018/2018-04.pdf"
    if not path.is_file():
        return
    parsed = mod.parse_payroll_pdf(path)
    assert parsed["format"] == "unholster_scan"
    assert parsed["liquido_clp"] == 304_804
    assert parsed["employer_name"].upper().startswith("UNHOLSTER")


def test_unholster_scan_september_2018_liquido():
    path = CFRASER / "liquidaciones/2018/2018-09.pdf"
    if not path.is_file():
        return
    parsed = mod.parse_payroll_pdf(path)
    assert parsed["format"] == "unholster_scan"
    assert parsed["liquido_clp"] == 1_271_796


# Talana/Buk's header table (synthetic values): the value row sits under the headers.
TALANA_HEADER = (
    " DIAS TR.   DIAS ENF. DIAS VAC. DIAS FAL.          TOTAL IMPONIBLE         "
    "TOTAL NO IMPONIBLE     DESCTOS. LEYES SOC.    DESCUENTO APV"
)


def talana_values(apv: str) -> str:
    return (
        "  30,0           0           0         0,0           1.234.567                     0"
        f"                    123.456             {apv:>5}"
    )


class HeaderColumnTest(unittest.TestCase):
    def test_a_header_label_does_not_read_the_row_below(self) -> None:
        text = f"{TALANA_HEADER}\n{talana_values('0')}\n"
        self.assertIsNone(mod.amount_after_label(text, ("DESCUENTO APV",)))

    def test_the_header_column_reads_its_own_cell(self) -> None:
        text = f"{TALANA_HEADER}\n{talana_values('0')}\n"
        self.assertEqual(mod.amount_in_header_column(text, r"DESCUENTO A\.?P\.?V\.?"), 0)
        text = f"{TALANA_HEADER}\n{talana_values('2.500')}\n"
        self.assertEqual(mod.amount_in_header_column(text, r"DESCUENTO A\.?P\.?V\.?"), 2500)

    def test_a_blank_header_column_is_zero(self) -> None:
        text = f"{TALANA_HEADER}\n{talana_values('')}\n"
        self.assertEqual(mod.amount_in_header_column(text, r"DESCUENTO A\.?P\.?V\.?"), 0)

    def test_the_dotted_header_spelling_is_the_same_column(self) -> None:
        header = TALANA_HEADER.replace("DESCUENTO APV", "DESCUENTO A.P.V.")
        text = f"{header}\n{talana_values('0')}\n"
        self.assertEqual(mod.amount_in_header_column(text, r"DESCUENTO A\.?P\.?V\.?"), 0)

    def test_no_header_is_none(self) -> None:
        self.assertIsNone(
            mod.amount_in_header_column("Sueldo Base   1.000.000\n", r"DESCUENTO A\.?P\.?V\.?")
        )

    def test_a_rate_before_the_amount_is_not_the_amount(self) -> None:
        text = "Isapre 7%                           12,345\n"
        self.assertEqual(mod.amount_after_label(text, ("FONASA INP", "Isapre")), 12345)


BUK_TEXT = """Liquidación de Sueldo
Empleador: Ejemplo Software SpA (76.000.000-k)
Mes: Septiembre 2030
Sr(a): Persona, Ejemplo                Tipo Contrato: Indefinido          Previsión: Uno (10.46%)
RUT: 11.111.111-1                      Inicio Contrato: 01 enero 2030     UF: $ 40.000,50
Sueldo Base: $ 2.000.000
               HABERES IMPONIBLES          $ 2.100.000          DESCUENTOS LEGALES      $ 457.000
    Sueldo Base                            $ 2.000.000    Cotiz. Previ. Obligatoria     $ 210.000
    Gratificación                            $ 100.000    Cotiz. Salud Obligatoria      $ 147.000
                                                          Adicional Salud                $ 10.000
               HABERES NO IMPONIBLES         $ 150.000
                                                          Impuesto Único                 $ 90.000
    Colación                                  $ 100.000
    Movilización                               $ 50.000           OTROS DESCUENTOS          $0
                      TOTAL HABERES $ 2.250.000                     TOTAL DESCUENTOS $ 457.000
                                  LÍQUIDO A RECIBIR: $ 1.793.000
                                                  buk.cl
"""


class BukLayoutTest(unittest.TestCase):
    def test_reads_every_field(self) -> None:
        self.assertEqual(mod.detect_format(BUK_TEXT), "buk")
        p = mod.parse_buk(BUK_TEXT, "2030-09")
        self.assertEqual(
            (p["employer_name"], p["employer_rut"], p["base_salary_clp"], p["desc_health_clp"], p["liquido_clp"], p["uf_mes"]),
            ("Ejemplo Software SpA", "76.000.000-K", 2_000_000, 157_000, 1_793_000, 40000.5),
        )
        self.assertEqual((p["desc_cesantia_clp"], p["desc_other_clp"], p["total_no_imponible_clp"]), (0, 0, 150_000))

    def test_lines_that_do_not_add_up_fail(self) -> None:
        with self.assertRaisesRegex(ValueError, "líquido"):
            mod.parse_buk(BUK_TEXT.replace("$ 1.793.000", "$ 1.793.001"), "2030-09")


if __name__ == "__main__":
    unittest.main()
