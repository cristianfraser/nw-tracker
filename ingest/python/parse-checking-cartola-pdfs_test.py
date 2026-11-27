#!/usr/bin/env python3
"""Tests for the cuenta corriente cartola PDF parser.

Each synthetic cartola comes in the two renderings the parser reads (`cartola_pdf_fixture.py`):
the `pdftotext -layout` text and the PDF's word positions. Branches, descriptions and amounts are
invented.

  python3 ingest/python/parse-checking-cartola-pdfs_test.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cartola_pdf_fixture import (  # noqa: E402
    GRID_HEADER,
    LAYOUT_HEADER,
    cells as _cells,
    grid_page,
    grid_row,
    layout_row,
    layout_text as cartola_text,
    load_parser,
    parse,
    words_from_grid,
)

mod = load_parser()


def movement_cells(parsed) -> list:
    return [(m.occurred_on, m.branch, m.description, m.document_no, m.amount_clp) for m in parsed.movements]


class SingleSpaceLayoutTest(unittest.TestCase):
    """The October 2026 layout: pdftotext puts one space between branch and description."""

    def setUp(self) -> None:
        grid = grid_page(
            [
                grid_row("02/10", "Centro", "Traspaso a Cuenta de Otro Banco", amount="25.000"),
                grid_row("05/10", "Centro", "*/Giro Nacional VD", "1112223", "40.000 35.000"),
                grid_row("06/10", "G.Ejemplo", "0111111111 DEVOLUCION      TIENDA EJEM", amount="12.345"),
                grid_row("07/10", "Centro", "0222222222 Transf. EMPRESA EJEMPLO SEG", "3334445", "1 47.346"),
                grid_row("08/10", "OPER. SUR", "0333333333K Remuneraciones Octubre 2026", "4445556", "500.000 547.346"),
            ]
        )
        layout = cartola_text(
            [
                layout_row("02/10 Centro Traspaso a Cuenta de Otro Banco", cargo="25.000"),
                layout_row(
                    "05/10 Centro */Giro Nacional VD                           1112223",
                    cargo="40.000",
                    saldo="35.000",
                ),
                layout_row("06/10 G.Ejemplo 0111111111 DEVOLUCION      TIENDA EJEM", abono="12.345"),
                layout_row(
                    "07/10 Centro 0222222222 Transf. EMPRESA EJEMPLO SEG 3334445",
                    abono="1",
                    saldo="47.346",
                ),
                layout_row(
                    "08/10 OPER. SUR 0333333333K Remuneraciones Octubre 2026     4445556",
                    abono="500.000",
                    saldo="547.346",
                ),
            ],
            opening="100.000",
            abonos="512.346",
            cargos="65.000",
            closing="547.346",
        )
        self.parsed = parse(layout, grid)

    def test_parses_and_reconciles(self) -> None:
        self.assertEqual(self.parsed.parse_status, "ok", self.parsed.parse_error)
        self.assertEqual(len(self.parsed.movements), 5)

    def test_branch_and_description_split_by_position(self) -> None:
        cells = movement_cells(self.parsed)
        self.assertEqual(cells[0], ("2026-10-02", "Centro", "Traspaso a Cuenta de Otro Banco", "", -25000))
        self.assertEqual(cells[1], ("2026-10-05", "Centro", "*/Giro Nacional VD", "1112223", -40000))
        self.assertEqual(
            cells[4],
            ("2026-10-08", "OPER. SUR", "0333333333K Remuneraciones Octubre 2026", "4445556", 500000),
        )

    def test_refund_row_with_a_full_width_branch(self) -> None:
        # The description is the PDF's words one space apart: the run of spaces inside it is gone.
        self.assertEqual(
            movement_cells(self.parsed)[2],
            ("2026-10-06", "G.Ejemplo", "0111111111 DEVOLUCION TIENDA EJEM", "", 12345),
        )

    def test_one_peso_row_keeps_amount_and_saldo_out_of_the_text(self) -> None:
        self.assertEqual(
            movement_cells(self.parsed)[3],
            ("2026-10-07", "Centro", "0222222222 Transf. EMPRESA EJEMPLO SEG", "3334445", 1),
        )


class SharedTextReadingTest(unittest.TestCase):
    """Every movement's cells go through the shared reading (`cartola_text.py`)."""

    def test_accent_damage_is_repaired_and_spaces_collapse(self) -> None:
        grid = grid_page([grid_row("02/10", "Centro", "Transf a JosA© MuA±oz", amount="25.000 75.000")])
        layout = cartola_text(
            [layout_row("02/10 Centro Transf a JosA© MuA±oz", cargo="25.000", saldo="75.000")],
            opening="100.000",
            abonos="0",
            cargos="25.000",
            closing="75.000",
        )
        parsed = parse(layout, grid)
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        self.assertEqual(movement_cells(parsed), [("2026-10-02", "Centro", "Transf a José Muñoz", "", -25000)])


class WideGapLayoutTest(unittest.TestCase):
    """The layout before September 2026: wide gaps between the cells, read as before."""

    def test_wide_gap_rows(self) -> None:
        grid = [
            _cells((10, "DETALLE DE MOVIMIENTOS")),
            GRID_HEADER,
            _cells((0, "01/10"), (6, "Centro"), (17, "0444444444 Transf. Ejemplo SpA"), (62, "1234567"), (90, "60.000")),
            _cells((0, "03/10"), (6, "Centro"), (17, "COM.MANTENCION PLAN"), (90, "5.000 75.000")),
            "INFORMACION DE CUENTA CORRIENTE",
        ]
        layout = "\n".join(
            [
                _cells((80, "CARTOLA"), (95, "DESDE"), (110, "HASTA")),
                _cells((82, "117"), (92, "30/09/2026"), (108, "30/10/2026")),
                _cells((20, "DETALLE DE MOVIMIENTOS")),
                *LAYOUT_HEADER,
                layout_row(
                    _cells((0, "01/10"), (11, "Centro"), (27, "0444444444 Transf. Ejemplo SpA"), (86, "1234567")),
                    abono="60.000",
                ),
                layout_row(_cells((0, "03/10"), (11, "Centro"), (27, "COM.MANTENCION PLAN")), cargo="5.000", saldo="75.000"),
                "",
                "INFORMACION DE CUENTA CORRIENTE",
                "SALDO INICIAL  DEPOSITOS  OTROS ABONOS  CHEQUES  OTROS CARGOS  IMPUESTOS  SALDO FINAL",
                "20.000  0  60.000  0  5.000  0  75.000",
            ]
        )
        parsed = parse(layout, grid)
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        self.assertEqual(
            movement_cells(parsed),
            [
                ("2026-10-01", "Centro", "0444444444 Transf. Ejemplo SpA", "1234567", 60000),
                ("2026-10-03", "Centro", "COM.MANTENCION PLAN", "", -5000),
            ],
        )


class ColumnErrorTest(unittest.TestCase):
    def _layout(self) -> str:
        return cartola_text(
            [layout_row("02/10 Centro Traspaso a Cuenta de Otro Banco", cargo="25.000", saldo="75.000")],
            opening="100.000",
            abonos="0",
            cargos="25.000",
            closing="75.000",
        )

    def test_row_with_nothing_in_the_branch_column_raises(self) -> None:
        # The PDF places the row's first cell right of the SUCURSAL label: it fits no branch.
        grid = grid_page([_cells((0, "02/10"), (17, "Centro Traspaso a Cuenta de Otro Banco"), (90, "25.000 75.000"))])
        parsed = parse(self._layout(), grid)
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("synthetic.pdf", parsed.parse_error)
        self.assertIn("02/10", parsed.parse_error)
        self.assertIn("SUCURSAL", parsed.parse_error)
        self.assertEqual(parsed.movements, [])

    def test_table_without_its_header_raises(self) -> None:
        grid = [
            _cells((10, "DETALLE DE MOVIMIENTOS")),
            grid_row("02/10", "Centro", "Traspaso a Cuenta de Otro Banco", amount="25.000"),
        ]
        with self.assertRaises(mod.CartolaColumnError) as ctx:
            mod.checking_table_rows([words_from_grid(grid)], "synthetic.pdf")
        self.assertIn("synthetic.pdf", str(ctx.exception))

    def test_layout_line_the_pdf_does_not_place_raises(self) -> None:
        parsed = mod.parse_cartola_text(self._layout(), "synthetic.pdf", "pdftotext", [])
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("02/10 Centro Traspaso", parsed.parse_error)


def one_row_layout(*rows: str) -> str:
    return cartola_text(list(rows), opening="100.000", abonos="0", cargos="25.000", closing="75.000")


class RowCrossCheckTest(unittest.TestCase):
    """The k-th dated layout line and the PDF's k-th row must be the same row."""

    LINE = layout_row("02/10 Centro Traspaso a Cuenta de Otro Banco", cargo="25.000", saldo="75.000")

    def test_date_mismatch_raises(self) -> None:
        grid = grid_page([grid_row("03/10", "Centro", "Traspaso a Cuenta de Otro Banco", amount="25.000 75.000")])
        parsed = parse(one_row_layout(self.LINE), grid)
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("03/10", parsed.parse_error)
        self.assertIn("02/10", parsed.parse_error)

    def test_pdf_row_without_a_layout_line_raises(self) -> None:
        grid = grid_page(
            [
                grid_row("02/10", "Centro", "Traspaso a Cuenta de Otro Banco", amount="25.000 75.000"),
                grid_row("04/10", "Centro", "COM.MANTENCION PLAN", amount="1.000"),
            ]
        )
        # The repeated row under «Resumen de Comisiones» is outside the table in both renderings.
        parsed = parse(one_row_layout(self.LINE), grid)
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("04/10 Centro COM.MANTENCION PLAN", parsed.parse_error)
        self.assertIn("has no layout line", parsed.parse_error)

    def test_line_that_does_not_open_with_its_branch_raises(self) -> None:
        grid = grid_page([grid_row("02/10", "Norte", "Traspaso a Cuenta de Otro Banco", amount="25.000 75.000")])
        parsed = parse(one_row_layout(self.LINE), grid)
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("synthetic.pdf", parsed.parse_error)
        self.assertIn("Norte", parsed.parse_error)
        self.assertIn("Centro Traspaso a Cuenta de Otro Banco", parsed.parse_error)

    def test_same_day_rows_swapped_between_renderings_raise(self) -> None:
        grid = grid_page(
            [
                grid_row("02/10", "Centro", "Transf a Persona Dos", amount="5.000"),
                grid_row("02/10", "Centro", "Transf a Persona Uno", amount="20.000 75.000"),
            ]
        )
        layout = one_row_layout(
            layout_row("02/10 Centro Transf a Persona Uno", cargo="20.000"),
            layout_row("02/10 Centro Transf a Persona Dos", cargo="5.000", saldo="75.000"),
        )
        parsed = parse(layout, grid)
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("Transf a Persona Uno", parsed.parse_error)
        self.assertIn("Transf a Persona Dos", parsed.parse_error)

    def test_branch_word_right_of_the_sucursal_label_raises(self) -> None:
        # «Villa Alta»: the second word starts right of the SUCURSAL label's edge (col 16), so it
        # would read as the description's first word; its row's description starts off the column.
        grid = grid_page(
            [
                grid_row("01/10", "Centro", "Traspaso a Cuenta de Otro Banco", amount="25.000"),
                _cells((0, "02/10"), (6, "Villa"), (12, "AltaLejana"), (17, "Deposito en Efectivo"), (90, "7.000")),
            ]
        )
        with self.assertRaises(mod.CartolaColumnError) as ctx:
            mod.checking_table_rows([words_from_grid(grid)], "synthetic.pdf")
        self.assertIn("02/10 Villa AltaLejana", str(ctx.exception))
        self.assertIn("DESCRIPCION column", str(ctx.exception))


class TwoPageTableTest(unittest.TestCase):
    def test_table_continues_under_the_repeated_header(self) -> None:
        page1 = [
            _cells((10, "DETALLE DE MOVIMIENTOS")),
            GRID_HEADER,
            grid_row("02/10", "Centro", "Traspaso a Cuenta de Otro Banco", amount="25.000 75.000"),
        ]
        page2 = grid_page([grid_row("05/10", "Centro", "COM.MANTENCION PLAN", amount="5.000 70.000")])
        layout = cartola_text(
            [
                layout_row("02/10 Centro Traspaso a Cuenta de Otro Banco", cargo="25.000", saldo="75.000"),
                _cells((20, "DETALLE DE MOVIMIENTOS")),
                *LAYOUT_HEADER,
                layout_row("05/10 Centro COM.MANTENCION PLAN", cargo="5.000", saldo="70.000"),
            ],
            opening="100.000",
            abonos="0",
            cargos="30.000",
            closing="70.000",
        )
        rows = mod.checking_table_rows([words_from_grid(page1), words_from_grid(page2)], "synthetic.pdf")
        self.assertEqual([(r.page, r.dd_mm) for r in rows], [(1, "02/10"), (2, "05/10")])
        parsed = mod.parse_cartola_text(layout, "synthetic.pdf", "pdftotext", rows)
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        self.assertEqual(
            movement_cells(parsed),
            [
                ("2026-10-02", "Centro", "Traspaso a Cuenta de Otro Banco", "", -25000),
                ("2026-10-05", "Centro", "COM.MANTENCION PLAN", "", -5000),
            ],
        )


class StackedLayoutTest(unittest.TestCase):
    """pdftotext stacks the 2018–2021 rows: date, branch and description on three lines. Their PDF
    prints date and branch as one word."""

    GRID = grid_page(
        [
            _cells((0, "02/10Centro"), (17, "Traspaso a Cuenta de Otro Banco"), (90, "25.000")),
            _cells((0, "05/10Centro"), (17, "COM.MANTENCION PLAN"), (90, "5.000 70.000")),
        ]
    )

    @staticmethod
    def layout(second_description: str) -> str:
        return cartola_text(
            [
                "02/10",
                "    Centro",
                layout_row(_cells((12, "Traspaso a Cuenta de Otro Banco")), cargo="25.000"),
                "05/10",
                "    Centro",
                layout_row(_cells((12, second_description)), cargo="5.000", saldo="70.000"),
            ],
            opening="100.000",
            abonos="0",
            cargos="30.000",
            closing="70.000",
        )

    def test_stacked_layout_is_identified_and_parsed(self) -> None:
        layout = self.layout("COM.MANTENCION PLAN")
        self.assertTrue(mod.layout_is_stacked(layout, "synthetic.pdf"))
        rows = mod.checking_table_rows([words_from_grid(self.GRID)], "synthetic.pdf")
        self.assertEqual([(r.dd_mm, r.branch) for r in rows], [("02/10", "Centro"), ("05/10", "Centro")])
        parsed = mod.parse_cartola_text(layout, "synthetic.pdf", "pdftotext", rows)
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        self.assertEqual(
            movement_cells(parsed),
            [
                ("2026-10-02", "Centro", "Traspaso a Cuenta de Otro Banco", "", -25000),
                ("2026-10-05", "Centro", "COM.MANTENCION PLAN", "", -5000),
            ],
        )

    def test_stacked_cells_come_from_the_pdf_positions(self) -> None:
        # pdftotext glues a document number to the description; a leading number stays in the
        # description (the xlsx prints it there); a word printed past the document number is the
        # description's.
        grid = grid_page(
            [
                _cells((0, "02/10Centro"), (17, "Traspaso a Cuentaejemplo"), (62, "1234567"), (90, "25.000")),
                _cells((0, "03/10Norte"), (17, "0111111111 Transf EJEMPLO"), (90, "5.000")),
                _cells((0, "04/10Centro"), (17, "PAGO EN LINEA EJEMPLO"), (62, "7654321"), (71, "S.A."), (90, "3.000 67.000")),
            ]
        )
        layout = cartola_text(
            [
                "02/10",
                "    Centro",
                layout_row(_cells((12, "Traspaso a Cuentaejemplo1234567")), cargo="25.000"),
                "03/10",
                "    Norte",
                layout_row(_cells((12, "0111111111 Transf EJEMPLO")), cargo="5.000"),
                "04/10",
                "    Centro",
                layout_row(_cells((12, "PAGO EN LINEA EJEMPLO 7654321 S.A.")), cargo="3.000", saldo="67.000"),
            ],
            opening="100.000",
            abonos="0",
            cargos="33.000",
            closing="67.000",
        )
        rows = mod.checking_table_rows([words_from_grid(grid)], "synthetic.pdf")
        parsed = mod.parse_cartola_text(layout, "synthetic.pdf", "pdftotext", rows)
        self.assertEqual(parsed.parse_status, "ok", parsed.parse_error)
        self.assertEqual(
            movement_cells(parsed),
            [
                ("2026-10-02", "Centro", "Traspaso a Cuentaejemplo", "1234567", -25000),
                ("2026-10-03", "Norte", "0111111111 Transf EJEMPLO", "", -5000),
                ("2026-10-04", "Centro", "PAGO EN LINEA EJEMPLO S.A.", "7654321", -3000),
            ],
        )

    def test_stacked_rows_must_hold_the_pdf_rows_words(self) -> None:
        rows = mod.checking_table_rows([words_from_grid(self.GRID)], "synthetic.pdf")
        parsed = mod.parse_cartola_text(self.layout("COM.OTRA COSA"), "synthetic.pdf", "pdftotext", rows)
        self.assertEqual(parsed.parse_status, "error")
        self.assertIn("05/10", parsed.parse_error)
        self.assertIn("COM.MANTENCION PLAN", parsed.parse_error)

    def test_single_line_and_stacked_rows_in_one_table_raise(self) -> None:
        layout = cartola_text(
            [
                "02/10",
                "    Centro",
                layout_row(_cells((12, "Traspaso a Cuenta de Otro Banco")), cargo="25.000"),
                layout_row("05/10 Centro COM.MANTENCION PLAN", cargo="5.000", saldo="70.000"),
            ],
            opening="100.000",
            abonos="0",
            cargos="30.000",
            closing="70.000",
        )
        with self.assertRaises(mod.CartolaColumnError):
            mod.layout_is_stacked(layout, "synthetic.pdf")


if __name__ == "__main__":
    unittest.main()
