"""Unit tests for the grocery receipt parser modules — synthetic texts only (a real boleta
carries the user's name and part of their RUT).

  python3 server/scripts/grocery_receipt_parse_test.py
"""
from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from grocery_receipt_model import ReceiptParseError  # noqa: E402
from grocery_receipt_parse import detect_chain, parse_receipt_text  # noqa: E402
from grocery_receipt_text import (  # noqa: E402
    OCR_ENGINE,
    OCR_ENGINE_VERSION,
    assemble_lines,
    sha256_file,
    staged_text_for_image,
)

STORE_PDF_TEXT = """\
                    express
                   de Lider
        SUC: CALLE FICTICIA #123, L.60
            COMUNA FICTICIA - SANTIAGO
              RUT: 76.134.946-5
Bol. Electronica: 000000000001 Caja: 0009
Fecha: 04/01/2037 Hora: 20:11:22
7800000000001 QUESO FICTICIO 100G          $  3.390
CODIGO: 7800000000002
2X1.250  GALLETA FICTICIA                  $  2.500
RF Lleve N x $                             $  -500
7800000000003 PALTA                        $  3.850
x 1.100 KG

RF CANJE PESOS MCL                         $  -240

                       SUBTOTAL            9.000
                       TOTAL AFECTO $      7.563
                       TOTAL EXENTO $          0
                       TOTAL IVA(19.0%)$   1.437
                       TOTAL $             9.000
TARJETA LIDER BCI                          9.000
VUELTO                                         0
TOTAL NUMERO DE ARTIC VEND  =  4

ACUMULACION
MI CLUB TARJETA LIDER BCI $ 120
"""

# The paper boleta as Apple Vision + assemble_lines render it: `$` missing on one item, a `,`
# thousands separator, pre-printed marketing text inside the item section, the COMPROBANTE
# block, points on one line.
PAPER_OCR_TEXT = """\
Precios bajos siempre,
para vivir mejor.
SUC: CALLE FICTICIA #123
COMUNA FICTICIA - SANTIAGO
RUT: 76.134.946-5
Bol. Electronica: 000000000002  Caja: 0006
Fecha: 28/08/2026  Hora: 12:41:47
7800000000001 QUESO FICTICIO 100G  $  3.390
7800000000004 QUESO REGG 201  4,550
Junta, ahorra y canjea cuando
quieras tus Pesos Mi Club
7800000000005 MOZZARELLA 226G  $  3.990
7800000000006 PASSATA  $  2.390
SUBTOTAL  14.320
TOTAL AFECTO $  12.034
TOTAL EXENTO $  0
TOTAL IVA(19.0%)$  2.286
TOTAL $  14.320
TARJETA LIDER BCI  14.320
VUELTO  0
TOTAL NUMERO DE ARTIC VEND = 4
COMPROBANTE VENTA LIDER BCI
TARJETA LIDERBCI: *********0000
COD.AUT.: 000000  NO. TRX: 000
MONTO: $ 14.320
** MI CLUB **
Nombre Ficticio
RUT CLIENTE MI CLUB: *****0000
ACUMULACION MI CLUB T.LIDERBCI $ 858
TOTAL ACUMULADO $ 31348 *
"""


class LiderStoreTemplateTest(unittest.TestCase):
    def test_items_discount_scopes_payments(self) -> None:
        p = parse_receipt_text(STORE_PDF_TEXT)
        self.assertEqual(p.chain, "lider")
        self.assertEqual(p.boleta_number, "000000000001")
        self.assertEqual(p.caja, "0009")
        self.assertEqual(p.sucursal, "CALLE FICTICIA #123, L.60")
        self.assertEqual(p.city, "COMUNA FICTICIA - SANTIAGO")
        self.assertEqual(p.purchased_at, "2037-01-04 20:11:22")
        self.assertEqual([i.description for i in p.items], ["QUESO FICTICIO 100G", "GALLETA FICTICIA", "PALTA"])
        self.assertEqual([i.barcode for i in p.items], ["7800000000001", "7800000000002", "7800000000003"])
        galleta = p.items[1]
        self.assertEqual((galleta.qty, galleta.unit_price_clp, galleta.total_clp, galleta.discount_clp), ("2", 1250, 2500, 500))
        palta = p.items[2]
        self.assertEqual((palta.qty, palta.qty_unit, palta.unit_price_clp), ("1.100", "kg", 3500))
        self.assertEqual(p.receipt_discounts, [{"label": "RF CANJE PESOS MCL", "amount_clp": 240}])
        self.assertEqual(p.payments, [{"method": "tarjeta_lider_bci", "amount_clp": 9000}])
        self.assertEqual(p.total_printed_clp, 9000)
        self.assertEqual(p.articles_declared, 4)
        self.assertEqual(p.mi_club_points, 120)
        self.assertEqual(p.ignored_lines, [])

    def test_balance_failure_raises(self) -> None:
        text = STORE_PDF_TEXT.replace("TARJETA LIDER BCI                          9.000", "TARJETA LIDER BCI                          9.500")
        with self.assertRaisesRegex(ReceiptParseError, "does not balance"):
            parse_receipt_text(text)

    def test_article_count_mismatch_raises(self) -> None:
        text = STORE_PDF_TEXT.replace("TOTAL NUMERO DE ARTIC VEND  =  4", "TOTAL NUMERO DE ARTIC VEND  =  5")
        with self.assertRaisesRegex(ReceiptParseError, "article count: printed 5 vs parsed 4"):
            parse_receipt_text(text)

    def test_digit_bearing_unknown_line_still_raises(self) -> None:
        text = STORE_PDF_TEXT.replace("x 1.100 KG\n", "x 1.100 KG\nOFERTA 2 POR 1 HOY\n")
        with self.assertRaisesRegex(ReceiptParseError, "unrecognised line"):
            parse_receipt_text(text)


class LiderPaperOcrTest(unittest.TestCase):
    def test_paper_ocr_variant_parses(self) -> None:
        p = parse_receipt_text(PAPER_OCR_TEXT)
        self.assertEqual(p.chain, "lider")
        self.assertEqual(p.sucursal, "CALLE FICTICIA #123")
        self.assertEqual(p.purchased_at, "2026-08-28 12:41:47")
        self.assertEqual([(i.description, i.total_clp) for i in p.items],
                         [("QUESO FICTICIO 100G", 3390), ("QUESO REGG 201", 4550), ("MOZZARELLA 226G", 3990), ("PASSATA", 2390)])
        self.assertEqual(p.payments, [{"method": "tarjeta_lider_bci", "amount_clp": 14320}])
        self.assertEqual(p.total_printed_clp, 14320)
        self.assertEqual(p.articles_declared, 4)
        self.assertEqual(p.mi_club_points, 858)
        self.assertEqual(p.ignored_lines, ["Junta, ahorra y canjea cuando", "quieras tus Pesos Mi Club"])

    def test_comprobante_block_never_adds_a_payment_leg(self) -> None:
        p = parse_receipt_text(PAPER_OCR_TEXT)
        self.assertEqual(len(p.payments), 1)


class ChainRegistryTest(unittest.TestCase):
    def test_lider_by_rut(self) -> None:
        self.assertEqual(detect_chain("... RUT: 76.134.946-5 ...").slug, "lider")
        self.assertEqual(detect_chain("RUT 76134946-5").slug, "lider")
        # Second Walmart entity (hipermercado / delivery boletas).
        self.assertEqual(detect_chain("SUC: X\nRUT: 76.134.941-4\n").slug, "lider")
        # Delivery template: the RUT stands bare on its own header line.
        self.assertEqual(detect_chain("AV.PDTE.EDO.FREI MONTALVA 8301,QUILICURA\n                76134941-4\n   SUC: X\n").slug, "lider")

    def test_bare_digits_inside_a_line_are_not_a_rut(self) -> None:
        # A bare RUT is only accepted alone on a line; codes or amounts inside text never match.
        with self.assertRaisesRegex(ReceiptParseError, "no issuer RUT"):
            detect_chain("ORDEN 76134946-5 ENTREGADA\n")

    def test_registered_chain_without_parser_names_itself(self) -> None:
        with self.assertRaisesRegex(ReceiptParseError, "jumbo: receipt recognised by its issuer RUT but no parser"):
            parse_receipt_text("JUMBO\nRUT: 81.201.000-K\n")

    def test_unknown_rut_and_missing_rut_raise(self) -> None:
        with self.assertRaisesRegex(ReceiptParseError, "unknown chain"):
            detect_chain("RUT: 12.345.678-9")
        with self.assertRaisesRegex(ReceiptParseError, "no issuer RUT"):
            detect_chain("no rut here 12.345.678-9")


def _block(text: str, x: float, y: float, w: float, h: float, conf: float = 1.0) -> dict:
    return {"text": text, "conf": conf, "x": x, "y": y, "w": w, "h": h,
            "tl": [x, y + h], "tr": [x + w, y + h], "bl": [x, y], "br": [x + w, y]}


class AssembleLinesTest(unittest.TestCase):
    def test_rows_by_height_and_junk_never_bridges_two_rows(self) -> None:
        # Two item rows (Vision origin bottom-left: the higher y is the upper row), a price
        # column, and one tall low-confidence `cscs` block where the `$` sits, spanning both.
        ocr = {"width": 900, "height": 2600, "blocks": [
            _block("7801970026099 SALCHICHA250", 0.03, 0.634, 0.55, 0.0132),
            _block("7803403004094 PAN BCO SB", 0.03, 0.6184, 0.50, 0.0129),
            _block("cscs", 0.704, 0.6184, 0.033, 0.0287, conf=0.3),
            _block("3.850", 0.867, 0.6327, 0.108, 0.0158),
            _block("3.490", 0.867, 0.6184, 0.108, 0.0172),
        ]}
        self.assertEqual(assemble_lines(ocr), "7801970026099 SALCHICHA250  3.850\n7803403004094 PAN BCO SB  3.490\n")

    def test_low_confidence_block_with_digits_is_kept(self) -> None:
        ocr = {"width": 900, "height": 2600, "blocks": [
            _block("7800000000001 QUESO", 0.03, 0.634, 0.55, 0.0132),
            _block("3.390", 0.867, 0.634, 0.108, 0.0132, conf=0.4),
        ]}
        self.assertEqual(assemble_lines(ocr), "7800000000001 QUESO  3.390\n")

    def test_skewed_rows_still_cluster(self) -> None:
        # Rotate a level receipt by 2° about the image centre; a row's right end then sits more
        # than a row height below its left end in raw y. De-skew must undo that.
        width, height = 900.0, 2600.0
        theta = math.radians(2.0)
        rows = [("7800000000001 QUESO FICTICIO", "3.390", 0.70), ("7800000000004 QUESO REGG", "4.550", 0.685), ("7800000000005 MOZZARELLA", "3.990", 0.670)]
        blocks = []
        for desc, price, y in rows:
            for text, x, w in ((desc, 0.03, 0.55), (price, 0.867, 0.108)):
                blocks.append(_rotated_block(text, x, y, w, 0.0132, theta, width, height))
        text = assemble_lines({"width": width, "height": height, "blocks": blocks})
        self.assertEqual(text.splitlines(), [f"{d}  {p}" for d, p, _ in rows])


def _rotated_block(text: str, x: float, y: float, w: float, h: float, theta: float, width: float, height: float) -> dict:
    """A level block rotated by theta about the image centre (Vision coordinates)."""
    def rot(px: float, py: float) -> list[float]:
        # to pixels, y up → rotate → back to normalised
        X, Y = px * width - width / 2, py * height - height / 2
        rx, ry = X * math.cos(theta) - Y * math.sin(theta), X * math.sin(theta) + Y * math.cos(theta)
        return [(rx + width / 2) / width, (ry + height / 2) / height]
    tl, tr, bl, br = rot(x, y + h), rot(x + w, y + h), rot(x, y), rot(x + w, y)
    xs = [p[0] for p in (tl, tr, bl, br)]
    ys = [p[1] for p in (tl, tr, bl, br)]
    return {"text": text, "conf": 1.0, "x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys),
            "tl": tl, "tr": tr, "bl": bl, "br": br}


class StagedTextTest(unittest.TestCase):
    def test_corrected_text_wins_and_a_valid_cache_skips_ocr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            image = d / "receipt.jpg"
            image.write_bytes(b"not really an image")
            (d / "ocr.json").write_text(json.dumps({
                "engine": OCR_ENGINE, "engine_version": OCR_ENGINE_VERSION,
                "source_sha256": sha256_file(image), "width": 10, "height": 10, "blocks": [],
            }))
            (d / "ocr.txt").write_text("machine text\n")
            # No corrected file: the cached OCR text is returned without touching the engine.
            self.assertEqual(staged_text_for_image(d, image), ("machine text\n", "ocr"))
            (d / "ocr.corrected.txt").write_text("human text\n")
            self.assertEqual(staged_text_for_image(d, image), ("human text\n", "ocr_corrected"))


if __name__ == "__main__":
    unittest.main()
