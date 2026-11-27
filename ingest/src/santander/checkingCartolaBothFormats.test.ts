import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import XLSX from "xlsx";
import { statementFromParsedCartola } from "./cartolas.js";
import { parseCheckingCartolaWorkbook, type ParsedCheckingCartola } from "./checkingCartolaXlsx.js";

/**
 * One synthetic month (`testdata/cartolaMonthBothFormats.json`) read through both cuenta
 * corriente readers — the workbook built from it through the xlsx reader, the PDF renderings built
 * from it (`ingest/python/cartola_pdf_fixture.py`) through the PDF parser — must be one statement:
 * the same days, signed pesos, branches, descriptions, document numbers, positions and balances.
 */

type MonthRow = { date: string; branch: string; xlsx: string; doc?: string; cargo?: number; abono?: number };
type MonthSpec = { file_xlsx: string; desde: string; hasta: string; opening: number; rows: MonthRow[] };

const here = path.dirname(fileURLToPath(import.meta.url));
const specFile = path.join(here, "testdata", "cartolaMonthBothFormats.json");
const pythonDir = path.join(here, "..", "..", "python");
const spec = JSON.parse(fs.readFileSync(specFile, "utf8")) as MonthSpec;

/** A peso cell as the bank prints it («$1.234.567»). */
const pesos = (n: number) => `$${String(n).replace(/\B(?=(\d{3})+$)/g, ".")}`;

function workbookOf(s: MonthSpec): XLSX.WorkBook {
  let running = s.opening;
  const movements: unknown[][] = s.rows.map((r, i) => {
    running += (r.abono ?? 0) - (r.cargo ?? 0);
    const lastOfDay = i + 1 === s.rows.length || s.rows[i + 1]!.date !== r.date;
    return [r.date, r.branch, r.xlsx, r.doc ?? "", r.cargo ? pesos(r.cargo) : "", r.abono ? pesos(r.abono) : "", lastOfDay ? pesos(running) : ""];
  });
  const rows: unknown[][] = [
    ["", "", "", "", "Desde", s.desde],
    ["", "", "", "", "Hasta", s.hasta],
    ["Saldo inicial:", pesos(s.opening)],
    ["Saldo final:", pesos(running)],
    [],
    ["FECHA", "SUCURSAL", "DESCRIPCION", "N DOCUMENTO", "CARGO", "ABONO", "SALDO"],
    ...movements,
    [],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Cartola");
  return wb;
}

function pdfReading(): ParsedCheckingCartola {
  const r = spawnSync("python3", [path.join(pythonDir, "cartola_pdf_fixture.py"), specFile], {
    env: { ...process.env, PYTHONPATH: path.join(pythonDir, ".pdf_deps") },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`cartola_pdf_fixture.py exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as Omit<ParsedCheckingCartola, "source_file" | "skipped" | "notes"> & {
    parse_status: string;
    parse_error: string | null;
  };
  if (out.parse_status !== "ok") throw new Error(`the PDF parser did not read the month: ${out.parse_error}`);
  return { ...out, source_file: "synthetic.pdf", skipped: [], notes: [] };
}

/** What both formats must state alike (the document's name, skips and notes are the reader's own). */
function stated(c: ParsedCheckingCartola) {
  const { document: _document, skipped_rows: _skipped, notes: _notes, ...rest } = statementFromParsedCartola(c);
  return rest;
}

describe("a cartola month read from its xlsx and its PDF", () => {
  it("is one statement", () => {
    const xlsx = parseCheckingCartolaWorkbook(workbookOf(spec), spec.file_xlsx);
    const pdf = pdfReading();
    expect(xlsx.movements).toHaveLength(spec.rows.length);
    expect(stated(pdf)).toEqual(stated(xlsx));
  });

  it("reads the cells in the shared reading (spaces collapsed, accent damage repaired, the PDF's overflow word kept)", () => {
    const xlsx = parseCheckingCartolaWorkbook(workbookOf(spec), spec.file_xlsx);
    expect(xlsx.movements.map((m) => [m.description, m.document_no])).toEqual([
      ["Traspaso Internet a T. Crédito", ""],
      ["0111111111 Transf EJEMPLO UNO", "1234567"],
      ["0222222222 Transf a José Muñoz", ""],
      ["PAGO EN LINEA PROM. EJEMPLO S.A.", "7654321"],
      ["0333333333 REMUNERACION EMPRESA EJ", ""],
      ["COM.MANTENCION PLAN", ""],
    ]);
  });
});
