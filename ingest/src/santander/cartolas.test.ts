import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCheckingCartolas, readCuentaVistaCartolas, statementFromParsedCartola, statementsTheContractTakes } from "./cartolas.js";

function entry(file: string, status: "ok" | "error", error: string | null = null) {
  return {
    source_file: file,
    period_month: status === "ok" ? "2036-01" : "",
    period_from: status === "ok" ? "2035-12-31" : null,
    period_to: status === "ok" ? "2036-01-31" : null,
    saldo_inicial_clp: status === "ok" ? 1_000 : null,
    saldo_final_clp: status === "ok" ? 1_500 : null,
    cartola_no: null,
    movements:
      status === "ok"
        ? [{ occurred_on: "2036-01-10", amount_clp: 500, branch: "Centro", description: "Abono de prueba", document_no: "" }]
        : [],
    parse_status: status,
    parse_error: error,
    extractor: "pdftotext",
  };
}

describe("cartola PDF batch", () => {
  let root: string;
  const savedDir = process.env.CFRASER_CSV_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cartolas-"));
    fs.mkdirSync(path.join(root, "xlsx"));
    process.env.CFRASER_CSV_DIR = root;
    fs.writeFileSync(
      path.join(root, "checking-cartolas-from-pdf.json"),
      JSON.stringify({
        generated_at: "2036-02-01T00:00:00Z",
        pdfs_dir: root,
        cartolas: [
          entry("a.pdf", "ok"),
          entry("b.pdf", "error", "b.pdf: row «02/01 Centro …»: nothing in the SUCURSAL column"),
          entry("c.pdf", "ok"),
        ],
      })
    );
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.CFRASER_CSV_DIR;
    else process.env.CFRASER_CSV_DIR = savedDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("sends the readable cartolas and names the unreadable one", () => {
    const read = readCheckingCartolas({
      dir: path.join(root, "xlsx"),
      pdf: true,
      skipPdfParse: false,
      runParser: () => ({ ok: true }),
    });
    expect(read.statements.map((s) => s.document)).toEqual(["a.pdf", "c.pdf"]);
    expect(read.unreadable).toEqual([
      { document: "b.pdf", error: "b.pdf: row «02/01 Centro …»: nothing in the SUCURSAL column" },
    ]);

  });

  it("a parser that did not finish sends nothing of its PDFs, whatever JSON a previous run left", () => {
    const failed = () => ({ ok: false as const, error: "parse-checking-cartola-pdfs.py exited 2: PyMuPDF is required" });
    const checking = readCheckingCartolas({ dir: path.join(root, "xlsx"), pdf: true, skipPdfParse: false, runParser: failed });
    expect(checking.statements).toEqual([]);
    expect(checking.unreadable).toEqual([
      { document: "pdf", error: "parse-checking-cartola-pdfs.py exited 2: PyMuPDF is required" },
    ]);

    fs.writeFileSync(
      path.join(root, "cuenta-vista-cartolas-from-pdf.json"),
      JSON.stringify({ generated_at: "2036-02-01", pdfs_dir: root, cartolas: [entry("v.pdf", "ok")] })
    );
    const vista = readCuentaVistaCartolas({ skipPdfParse: false, runParser: () => ({ ok: false, error: "crashed" }) });
    expect(vista.statements).toEqual([]);
    expect(vista.unreadable).toEqual([{ document: "cuenta-vista-pdf", error: "crashed" }]);
  });
});

describe("statements the contract takes", () => {
  const statement = (document: string, description: string) =>
    statementFromParsedCartola({
      source_file: document,
      period_month: "2036-01",
      period_from: "2035-12-31",
      period_to: "2036-01-31",
      saldo_inicial_clp: 1_000,
      saldo_final_clp: 1_500,
      movements: [{ occurred_on: "2036-01-10", amount_clp: 500, branch: "Centro", description, document_no: "" }],
      skipped: [],
      notes: [],
    });

  it("sends the statements in the shared reading and names a document with a cell outside it as unreadable", () => {
    const read = statementsTheContractTakes({
      statements: [statement("a.pdf", "Abono de prueba"), statement("b.pdf", "Abono  de prueba")],
      unreadable: [],
    });
    expect(read.statements.map((s) => s.document)).toEqual(["a.pdf"]);
    expect(read.unreadable).toHaveLength(1);
    expect(read.unreadable[0]!.document).toBe("b.pdf");
    expect(read.unreadable[0]!.error).toMatch(/^movements\.0\.description «Abono  de prueba»: not in the shared cartola reading/);
  });
});
