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


def lines_of(text: str, fmt: str, parsed: dict) -> list:
    return [(l["side"], l["section"], l["label"], l["amount"]) for l in mod.extract_payslip_lines(text, fmt, parsed)]


# Two-column layout with printed subtotals (Nuevo Chile style; synthetic values).
SUBTOTAL_TEXT = """
HABERES                                                      DESCUENTOS
Sueldo del Mes                      1,000,000                AFP                                  110,000
Gratificación Mensual                 100,000                Isapre 7%                             77,000
Total Haberes Imponibles            1,100,000                Seguro de cesantía                     6,600
                                                             Impuesto Unico                        10,000
                                                             Total descuentos legales             203,600
Movilización                           50,000                Anticipo Aguinaldo                    20,000
Total Haberes No Imponibles            50,000                Total Otros Descuentos                20,000
Total Haberes                       1,150,000                Total Descuentos                    223,600
                                                             Alcance Líquido                   926,400
"""

# Talana: no section subtotal among the lines, amounts with «,00», a right-only row.
TALANA_TEXT = """
                       DETALLE DE HABERES                                               DETALLE DE DESCUENTOS
  Sueldo Ganado                                     1.000.000,00       Descuento AFP                                   110.000,00
  Seguro Vida Costo Empresa                            10.000,00       Cotizacion Salud                                 77.000,00
                                                                       Seguro Vida Costo Empresa                         9.000,00
  Asig. Colación                                       40.000,00
         TOTAL HABERES                              1.050.000,00            TOTAL DESCUENTOS                           196.000,00
"""


class PayslipLinesTest(unittest.TestCase):
    def test_reads_both_columns_with_their_sections(self) -> None:
        got = lines_of(SUBTOTAL_TEXT, "nuevo_chile", {"liquido_clp": 926_400})
        self.assertEqual(
            got,
            [
                ("haber", "imponible", "Sueldo del Mes", 1_000_000),
                ("haber", "imponible", "Gratificación Mensual", 100_000),
                ("haber", "no_imponible", "Movilización", 50_000),
                ("descuento", "legal", "AFP", 110_000),
                ("descuento", "legal", "Isapre 7%", 77_000),
                ("descuento", "legal", "Seguro de cesantía", 6_600),
                ("descuento", "legal", "Impuesto Unico", 10_000),
                ("descuento", "other", "Anticipo Aguinaldo", 20_000),
            ],
        )

    def test_a_missed_line_fails(self) -> None:
        text = SUBTOTAL_TEXT.replace("Anticipo Aguinaldo                    20,000", "")
        with self.assertRaisesRegex(ValueError, "lines add up"):
            mod.extract_payslip_lines(text, "nuevo_chile", {"liquido_clp": 926_400})

    def test_haberes_minus_descuentos_must_be_the_net_pay(self) -> None:
        with self.assertRaisesRegex(ValueError, "líquido"):
            mod.extract_payslip_lines(SUBTOTAL_TEXT, "nuevo_chile", {"liquido_clp": 926_401})

    def test_talana_non_taxable_lines_are_the_trailing_ones_adding_up_to_its_total(self) -> None:
        got = lines_of(TALANA_TEXT, "talana_buk", {"liquido_clp": 854_000, "total_no_imponible_clp": 40_000})
        self.assertEqual(
            got,
            [
                ("haber", "imponible", "Sueldo Ganado", 1_000_000),
                ("haber", "imponible", "Seguro Vida Costo Empresa", 10_000),
                ("haber", "no_imponible", "Asig. Colación", 40_000),
                ("descuento", None, "Descuento AFP", 110_000),
                ("descuento", None, "Cotizacion Salud", 77_000),
                ("descuento", None, "Seguro Vida Costo Empresa", 9_000),
            ],
        )

    def test_buk_right_column_left_of_its_header(self) -> None:
        got = lines_of(BUK_TEXT, "buk", {"liquido_clp": 1_793_000})
        self.assertEqual([g[2] for g in got if g[0] == "descuento"], ["Cotiz. Previ. Obligatoria", "Cotiz. Salud Obligatoria", "Adicional Salud", "Impuesto Único"])
        self.assertEqual({g[1] for g in got if g[0] == "descuento"}, {"legal"})

    def test_ocr_scan_reads_a_negative_haber_and_derives_a_missing_total(self) -> None:
        flat = (
            "HABERES IMPONIBLES SUELDO DE 30 DIAS $ 1,000,000 1 DiA(S) DE INASISTENCIA $ (30,000) "
            "TOTAL IMPONIBLES $ 970,000 NO IMPONIBLES COLACION $ 50,000 TOTAL NO IMPONIBLES $ 50,000 "
            "TOTALHABERES $ —___ DESCUENTOS A.F.P. MODELO 10.77% $ 100,000 IMPUESTO $ 2o,1eo "
            "TOTAL DESCUENTOS $ 120,000 TOTALAPAGAR $ 900,000"
        )
        parsed = {"liquido_clp": 900_000, "total_haberes_clp": None, "total_imponible_clp": 970_000,
                  "total_no_imponible_clp": 50_000, "total_descuentos_clp": 120_000, "desc_tax_clp": 20_000}
        got = lines_of(flat, "unholster_scan", parsed)
        self.assertIn(("haber", "imponible", "1 DiA(S) DE INASISTENCIA", -30_000), got)
        self.assertIn(("descuento", None, "IMPUESTO", 20_000), got)


if __name__ == "__main__":
    unittest.main()
