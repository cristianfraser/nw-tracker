#!/usr/bin/env python3
"""Unit tests for CC statement reconcile helpers (synthetic data only)."""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from typing import Optional

# Synthetic card registry (see ccCardsFixture.json) — never the personal cfraser/cc-cards.json.
os.environ["NW_TRACKER_CC_CARDS"] = str(
    Path(__file__).resolve().parents[1] / "src" / "test" / "ccCardsFixture.json"
)

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

SCRIPT = SCRIPT_DIR / "cc_statement_reconcile.py"
spec = importlib.util.spec_from_file_location("cc_statement_reconcile", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["cc_statement_reconcile"] = mod
spec.loader.exec_module(mod)


def parse_clp(raw: str) -> Optional[int]:
    s = str(raw or "").strip().replace(".", "")
    if not s or s in {"-", "$"}:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_usd(raw: str) -> Optional[float]:
    s = str(raw or "").strip().replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


# One synthetic rendering of a BCI/Líder EECC: transaction amounts share their line with
# text (never counted), group subtotals print as lone `$ amount` lines (counted).
BCI_RENDERING = """BANCO DE CREDITO E INVERSIONES
Numero tarjeta XXXXXXXXXXXX4343
1. Total Operaciones
LIDER
SANTIAGO CL 05/08/2026 TIENDA UNO (T) $ 10.000
SANTIAGO CL 09/08/2026 TIENDA DOS (T) $ 20.000
$ 30.000
OTROS COMERCIOS
SANTIAGO CL 12/08/2026 SERVICIO TRES (T) $ 70.000
$ 70.000
2. Productos o Servicios Voluntariamente Contratados
3. Cargos / Comisiones, Impuestos / Abonos
30/07/2026 PAGO $ -95.000
$ -95.000
Monto Total Facturado
$ 100.000
"""


class BciSubsectionTotalsTest(unittest.TestCase):
    def test_single_rendering_sums_group_subtotals_only(self) -> None:
        op, cargos, monto = mod._bci_subsection_totals_clp(BCI_RENDERING, parse_clp, parse_usd)
        self.assertEqual(op, 100000.0)
        self.assertIsNone(cargos)  # negative-only section 3 stays uncollected
        self.assertEqual(monto, 100000.0)

    def test_concatenated_dual_rendering_must_not_double(self) -> None:
        # The parse flow hands extract_pdf_section_totals BOTH extractions concatenated
        # (pypdf + pdftotext-layout). Summing collectors must work on ONE rendering:
        # the concat doubled pdf_total_operaciones on the 2026 mail-template statements
        # (2026-08 ·0101: 3.xxx.xxx = 2 x 1.xxx.xxx), which disarmed the import-level
        # monto_facturado check via its incomplete-parse hatch.
        concat = f"{BCI_RENDERING}\n{BCI_RENDERING}"
        totals = mod.extract_pdf_section_totals(
            concat, "clp", parse_clp, parse_usd, layout_text=BCI_RENDERING
        )
        self.assertEqual(totals["pdf_total_operaciones"], 100000.0)
        self.assertEqual(totals["pdf_monto_facturado"], 100000.0)

    def test_single_text_callers_keep_working_without_layout(self) -> None:
        totals = mod.extract_pdf_section_totals(BCI_RENDERING, "clp", parse_clp, parse_usd)
        self.assertEqual(totals["pdf_total_operaciones"], 100000.0)


if __name__ == "__main__":
    unittest.main()
