#!/usr/bin/env python3
"""Synthetic cuenta corriente cartola PDFs, for tests: the two renderings the parser reads — the
`pdftotext -layout` text and the PDF's word positions (`checking_table_rows`), written as a
fixed-pitch grid, one character per `PITCH` points. Branches, descriptions and amounts are
invented.

Run as a script on a month spec (`ingest/src/santander/testdata/cartolaMonthBothFormats.json`, the
fixture the xlsx reader's parity test also builds its workbook from), it prints the PDF parser's
reading of that month as JSON:

  PYTHONPATH=ingest/python/.pdf_deps python3 ingest/python/cartola_pdf_fixture.py <month.json>
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

PITCH = 4.8
LINE_HEIGHT = 10.0


def load_parser():
    """The PDF parser module (its file name has dashes)."""
    name = "parse_cc_cartola"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / "parse-checking-cartola-pdfs.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def cells(*items: tuple) -> str:
    """One line: each text at its column."""
    line = ""
    for col, text in items:
        line = line.ljust(col) + text
    return line


def right(end_col: int, text: str) -> tuple:
    """A right-aligned cell ending at `end_col`."""
    return (end_col - len(text), text)


def words_from_grid(lines: list) -> list:
    """The words of a fixed-pitch page as PyMuPDF reports them: (x0, y0, x1, y1, text)."""
    words = []
    for i, line in enumerate(lines):
        for m in re.finditer(r"\S+", line):
            y0 = i * LINE_HEIGHT
            words.append((m.start() * PITCH, y0, m.end() * PITCH, y0 + 8.0, m.group()))
    return words


# The PDF's grid: the header labels are centred over their columns, so the SUCURSAL label sits
# inside the branch cell's span and the description cell starts right of the label; a document
# number starts just left of the N° DCTO label, the amounts right of CHEQUES Y OTROS.
GRID_HEADER = cells((0, "FECHA"), (8, "SUCURSAL"), (40, "DESCRIPCION"), (63, "N° DCTO"), (80, "CHEQUES Y OTROS"))
GRID_DOC_COL = 62
GRID_AFTER_DOC_COL = 71


def grid_row(dd_mm: str, branch: str, description: str, doc: str = "", amount: str = "", after_doc: str = "") -> str:
    """One row as the PDF places it; `amount` holds the row's amount and, when printed, its saldo;
    `after_doc` a description word the PDF prints past the document number."""
    items = [(0, dd_mm), (6, branch), (17, description)]
    if doc:
        items.append((GRID_DOC_COL, doc))
    if after_doc:
        items.append((GRID_AFTER_DOC_COL, after_doc))
    if amount:
        items.append((90, amount))
    return cells(*items)


# The layout text: column titles where pdftotext puts them, amounts in their columns (CARGOS
# ending at 124, ABONOS at 150, SALDO at 180), and ONE space between branch and description.
LAYOUT_HEADER = [
    cells((1, "FECHA"), (13, "SUCURSAL"), (57, "DESCRIPCION"), (97, "N° DCTO"), (173, "SALDO")),
    cells((116, "CARGOS"), (141, "ABONOS")),
]


def layout_row(text: str, *, cargo: str = "", abono: str = "", saldo: str = "") -> str:
    items = [(0, text)]
    if cargo:
        items.append(right(124, cargo))
    if abono:
        items.append(right(150, abono))
    if saldo:
        items.append(right(180, saldo))
    return cells(*items)


def layout_text(
    rows: list, *, opening: str, abonos: str, cargos: str, closing: str, desde: str = "30/09/2026", hasta: str = "30/10/2026"
) -> str:
    return "\n".join(
        [
            cells((80, "CARTOLA"), (95, "DESDE"), (110, "HASTA")),
            cells((82, "117"), (92, desde), (108, hasta)),
            cells((20, "DETALLE DE MOVIMIENTOS")),
            *LAYOUT_HEADER,
            *rows,
            "",
            cells((20, "Resumen de Comisiones")),
            rows[0],
            "",
            "INFORMACION DE CUENTA CORRIENTE",
            "SALDO INICIAL  DEPOSITOS  OTROS ABONOS  CHEQUES  OTROS CARGOS  IMPUESTOS  SALDO FINAL",
            f"{opening}  0  {abonos}  0  {cargos}  0  {closing}",
            "MENSAJES       SR.CLIENTE: MENSAJE DE EJEMPLO",
        ]
    )


def grid_page(rows: list) -> list:
    return [
        cells((10, "DETALLE DE MOVIMIENTOS")),
        GRID_HEADER,
        *rows,
        "",
        cells((17, "Resumen de Comisiones")),
        rows[0],
        "INFORMACION DE CUENTA CORRIENTE",
    ]


def parse(layout: str, grid: list, source_file: str = "synthetic.pdf"):
    mod = load_parser()
    rows = mod.checking_table_rows([words_from_grid(grid)], source_file)
    return mod.parse_cartola_text(layout, source_file, "pdftotext", rows)


def pesos(n: int) -> str:
    return f"{n:,}".replace(",", ".")


def month_renderings(spec: dict) -> tuple:
    """A month spec's layout text and grid: each row's PDF description (`pdf`), its document number
    and the word printed past it, its amount, and the saldo at the day's last row."""
    rows = spec["rows"]
    running = spec["opening"]
    grid, layout = [], []
    abonos = cargos = 0
    for i, r in enumerate(rows):
        cargo, abono = r.get("cargo", 0), r.get("abono", 0)
        running += abono - cargo
        abonos += abono
        cargos += cargo
        last_of_day = i + 1 == len(rows) or rows[i + 1]["date"] != r["date"]
        saldo = pesos(running) if last_of_day else ""
        amount = pesos(cargo or abono)
        doc, after = r.get("doc", ""), r.get("pdf_after_doc", "")
        grid.append(grid_row(r["date"], r["branch"], r["pdf"], doc, f"{amount} {saldo}".strip(), after))
        text = " ".join(p for p in (r["date"], r["branch"], r["pdf"], doc, after) if p)
        layout.append(layout_row(text, cargo=pesos(cargo) if cargo else "", abono=pesos(abono) if abono else "", saldo=saldo))
    return (
        layout_text(
            layout,
            opening=pesos(spec["opening"]),
            abonos=pesos(abonos),
            cargos=pesos(cargos),
            closing=pesos(running),
            desde=spec["desde"],
            hasta=spec["hasta"],
        ),
        grid_page(grid),
    )


def main() -> int:
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    layout, grid = month_renderings(spec)
    parsed = parse(layout, grid)
    out = {
        "parse_status": parsed.parse_status,
        "parse_error": parsed.parse_error,
        "period_month": parsed.period_month,
        "period_from": parsed.period_from,
        "period_to": parsed.period_to,
        "saldo_inicial_clp": parsed.saldo_inicial_clp,
        "saldo_final_clp": parsed.saldo_final_clp,
        "movements": [
            {
                "occurred_on": m.occurred_on,
                "amount_clp": m.amount_clp,
                "branch": m.branch,
                "description": m.description,
                "document_no": m.document_no,
            }
            for m in parsed.movements
        ],
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
