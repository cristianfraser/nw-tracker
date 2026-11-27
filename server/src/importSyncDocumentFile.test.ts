import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImportSyncDocumentAccount } from "./importSyncDocumentTypes.js";

/** The matrix columns plus this file's own column, so the routes serve a test-owned workbook. */
const fixture = vi.hoisted(() => ({ column: null as ImportSyncDocumentAccount | null }));
vi.mock("./importSyncDocumentAccounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./importSyncDocumentAccounts.js")>();
  return {
    ...actual,
    listImportSyncDocumentAccounts: () => [
      ...actual.listImportSyncDocumentAccounts(),
      ...(fixture.column ? [fixture.column] : []),
    ],
  };
});

const { db } = await import("./db.js");
const {
  documentSendFailure,
  importSyncDocumentContentDisposition,
  importSyncDocumentPreviewKind,
  importSyncDocumentRef,
  IMPORT_SYNC_SHEET_PREVIEW_MAX_BYTES,
  pickImportSyncDocumentColumn,
  readImportSyncSheetPreview,
  resolveImportSyncDocumentFile,
} = await import("./importSyncDocumentFile.js");
const { InputError } = await import("./inputError.js");
const { registerSyncRoutes } = await import("./routes/sync.js");
const { terminalErrorHandler } = await import("./terminalErrorHandler.js");

const PREFIX = "vitest:doc-viewer";

/**
 * Every document folder (and the parsed-cartola JSON folder, left empty) points at a temporary
 * directory holding this file's own fixture files — never the real `cfraser/`.
 */
const DOCUMENT_DIR_ENV = [
  "CFRASER_PDFS_DIR",
  "CFRASER_CHECKING_CARTOLAS_DIR",
  "CFRASER_CHECKING_CARTOLA_PDFS_DIR",
  "CFRASER_CUENTA_VISTA_PDFS_DIR",
  "CFRASER_CARTOLA_PARSED_JSON_DIR",
] as const;
const savedEnv = new Map<string, string | undefined>();
let documentRoot = "";
let checkingDir = "";
let fixtureAccountId = 0;
let server: Server;
let base = "";

/** A blank one-page PDF. */
function blankPdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

/** The spreadsheet serial of a UTC instant (days since 1899-12-30). */
const serial = (utcMs: number) => (utcMs - Date.UTC(1899, 11, 30)) / 86_400_000;

/**
 * Two sheets: text, a formatted number, a real date cell and a real datetime cell, a boolean, an
 * empty row in the middle, trailing empty rows.
 */
function writeWorkbook(absPath: string): void {
  const wb = XLSX.utils.book_new();
  const movements = XLSX.utils.aoa_to_sheet([
    ["Fecha", "Detalle", "Monto", "Conciliado"],
    ["", "Synthetic transfer", 1234.5, true],
    [],
    ["", "Synthetic fee", -20, false],
    ["", "", ""],
    ["", "", ""],
  ]);
  movements["C2"]!.z = "#,##0.00";
  movements["A2"] = { t: "n", v: serial(Date.UTC(2031, 0, 5)), z: "yyyy-mm-dd" };
  movements["A4"] = { t: "n", v: serial(Date.UTC(2031, 0, 9, 14, 30)), z: "yyyy-mm-dd hh:mm" };
  XLSX.utils.book_append_sheet(wb, movements, "Movimientos");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Saldo", 99]]), "Resumen");
  fs.writeFileSync(absPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

const SHEET_FILE = "vitest-doc-viewer 2031-01 cartola.xlsx";
const PDF_NAME = "vitest-doc-viewer 2031-02 cartola año.pdf";
const LARGE_SHEET_FILE = "vitest-doc-viewer 2031-05 cartola.xlsx";

const insertCartola = (month: string, sourceFile: string) =>
  db
    .prepare(`INSERT INTO checking_cartola_imports (account_id, period_month, source_file, movement_count) VALUES (?, ?, ?, 1)`)
    .run(fixtureAccountId, month, sourceFile);

beforeAll(async () => {
  documentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nw-import-sync-doc-viewer-"));
  for (const key of DOCUMENT_DIR_ENV) {
    savedEnv.set(key, process.env[key]);
    const dir = path.join(documentRoot, key);
    fs.mkdirSync(dir);
    process.env[key] = dir;
  }
  checkingDir = process.env.CFRASER_CHECKING_CARTOLAS_DIR!;
  writeWorkbook(path.join(checkingDir, SHEET_FILE));
  fs.writeFileSync(path.join(checkingDir, PDF_NAME), blankPdf());
  // Sparse: over the preview limit without writing the bytes.
  fs.writeFileSync(path.join(checkingDir, LARGE_SHEET_FILE), "");
  fs.truncateSync(path.join(checkingDir, LARGE_SHEET_FILE), IMPORT_SYNC_SHEET_PREVIEW_MAX_BYTES + 1);

  // A deposit account: never a checking or cuenta vista member, so never one of the real columns.
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__dap'`).get() as { id: number };
  fixtureAccountId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, import_key, notes) VALUES (?, ?, ?, ?)`)
      .run(leaf.id, "Vitest · doc viewer", `${PREFIX}|account`, `${PREFIX}|account`).lastInsertRowid
  );
  insertCartola("2031-01", SHEET_FILE);
  insertCartola("2031-02", PDF_NAME);
  insertCartola("2031-05", LARGE_SHEET_FILE);
  fixture.column = { account_id: fixtureAccountId, label: "Vitest · doc viewer", document_kind: "checking_cartola" };

  const app = express();
  registerSyncRoutes(app);
  app.use(terminalErrorHandler);
  server = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fixture.column = null;
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ?`).run(fixtureAccountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(fixtureAccountId);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(documentRoot, { recursive: true, force: true });
});

const fixtureColumn = (): ImportSyncDocumentAccount => fixture.column!;

describe("pickImportSyncDocumentColumn", () => {
  const columns: ImportSyncDocumentAccount[] = [
    { account_id: 1, label: "checking", document_kind: "checking_cartola" },
    { account_id: 2, label: "card", document_kind: "cc_statement", cc_statement_currency: "clp" },
    { account_id: 2, label: "card", document_kind: "cc_statement", cc_statement_currency: "usd" },
    { account_id: 3, label: "card without dollars", document_kind: "cc_statement" },
  ];
  const statusOf = (accountId: number, slot: "clp" | "usd" | null): number => {
    try {
      pickImportSyncDocumentColumn(columns, accountId, slot);
    } catch (e) {
      if (e instanceof InputError) return e.status;
      throw e;
    }
    return 200;
  };

  it("picks a card's CLP or USD column by its slot, a column without a currency without one", () => {
    expect(pickImportSyncDocumentColumn(columns, 2, "usd")).toBe(columns[2]);
    expect(pickImportSyncDocumentColumn(columns, 2, "clp")).toBe(columns[1]);
    expect(pickImportSyncDocumentColumn(columns, 1, null)).toBe(columns[0]);
    expect(pickImportSyncDocumentColumn(columns, 3, null)).toBe(columns[3]);
  });

  it("refuses a request that does not name exactly one column", () => {
    expect(statusOf(2, null)).toBe(400);
    expect(statusOf(1, "clp")).toBe(400);
    expect(statusOf(3, "usd")).toBe(400);
    expect(statusOf(4, null)).toBe(404);
  });
});

describe("import-sync document files", () => {
  it("reads the preview kind from the extension, in any case", () => {
    expect(importSyncDocumentPreviewKind("a.pdf")).toBe("pdf");
    expect(importSyncDocumentPreviewKind("a.PDF")).toBe("pdf");
    expect(importSyncDocumentPreviewKind("a.Xlsx")).toBe("sheet");
    expect(() => importSyncDocumentPreviewKind("a.xls")).toThrow(/no preview/);
    expect(() => importSyncDocumentPreviewKind("a")).toThrow(/no preview/);
  });

  it("finds a month's file and builds the cell's links", () => {
    const sheet = resolveImportSyncDocumentFile(fixtureColumn(), "2031-01");
    expect(sheet.file_name).toBe(SHEET_FILE);
    expect(sheet.preview_kind).toBe("sheet");
    expect(importSyncDocumentRef(fixtureColumn(), "2031-01", sheet.abs_path)).toEqual({
      file_name: SHEET_FILE,
      preview_kind: "sheet",
      view_href: `/api/import-sync/documents/${fixtureAccountId}/2031-01/file`,
      download_href: `/api/import-sync/documents/${fixtureAccountId}/2031-01/file?download=1`,
      sheet_href: `/api/import-sync/documents/${fixtureAccountId}/2031-01/sheet`,
    });
    const pdf = resolveImportSyncDocumentFile(fixtureColumn(), "2031-02");
    expect(importSyncDocumentRef(fixtureColumn(), "2031-02", pdf.abs_path).sheet_href).toBeNull();
    expect(() => resolveImportSyncDocumentFile(fixtureColumn(), "2031-03")).toThrow(InputError);
  });

  it("names a card column's slot in every link", () => {
    const card: ImportSyncDocumentAccount = { account_id: 77, label: "", document_kind: "cc_statement", cc_statement_currency: "usd" };
    const ref = importSyncDocumentRef(card, "2031-01", "/x/2031-01-25 estado de cuenta tarjeta usd 0000.pdf");
    expect(ref.view_href).toBe("/api/import-sync/documents/77/2031-01/file?slot=usd");
    expect(ref.download_href).toBe("/api/import-sync/documents/77/2031-01/file?slot=usd&download=1");
  });

  it("refuses a stored absolute path or a symlink that leaves the document folders", () => {
    const outside = path.join(documentRoot, "outside");
    fs.mkdirSync(outside);
    const outsidePdf = path.join(outside, "vitest-doc-viewer outside.pdf");
    fs.writeFileSync(outsidePdf, blankPdf());
    const link = path.join(checkingDir, "vitest-doc-viewer link.pdf");
    fs.symlinkSync(outsidePdf, link);
    try {
      insertCartola("2031-03", outsidePdf);
      expect(() => resolveImportSyncDocumentFile(fixtureColumn(), "2031-03")).toThrow(/outside the checking_cartola document folders/);
      db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = '2031-03'`).run(fixtureAccountId);
      insertCartola("2031-04", path.basename(link));
      expect(() => resolveImportSyncDocumentFile(fixtureColumn(), "2031-04")).toThrow(/outside the checking_cartola document folders/);
    } finally {
      db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month IN ('2031-03', '2031-04')`).run(fixtureAccountId);
      fs.rmSync(link);
    }
  });

  it("reads every sheet's cells: text, raw numbers, dates, booleans, no trailing empty rows", () => {
    const { abs_path } = resolveImportSyncDocumentFile(fixtureColumn(), "2031-01");
    expect(readImportSyncSheetPreview(abs_path)).toEqual({
      file_name: SHEET_FILE,
      sheets: [
        {
          name: "Movimientos",
          rows: [
            ["Fecha", "Detalle", "Monto", "Conciliado"],
            ["2031-01-05", "Synthetic transfer", 1234.5, "TRUE"],
            ["", "", "", ""],
            ["2031-01-09 14:30", "Synthetic fee", -20, "FALSE"],
          ],
        },
        { name: "Resumen", rows: [["Saldo", 99]] },
      ],
    });
    const pdf = resolveImportSyncDocumentFile(fixtureColumn(), "2031-02");
    expect(() => readImportSyncSheetPreview(pdf.abs_path)).toThrow(InputError);
  });

  /** Writes `sheet` as the only sheet of a workbook in the checking folder and returns its path. */
  function writeOneSheet(fileName: string, sheet: XLSX.WorkSheet, date1904 = false): string {
    const wb = XLSX.utils.book_new();
    if (date1904) wb.Workbook = { WBProps: { date1904: true } };
    XLSX.utils.book_append_sheet(wb, sheet, "Hoja1");
    const abs = path.join(checkingDir, fileName);
    fs.writeFileSync(abs, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    return abs;
  }

  it("reads dates in the workbook's date system and a time alone as HH:MM", () => {
    const day1900 = serial(Date.UTC(2031, 0, 5));
    const sheet1904: XLSX.WorkSheet = {
      "!ref": "A1:C1",
      A1: { t: "n", v: day1900 - 1462, z: "yyyy-mm-dd" },
      B1: { t: "n", v: day1900 - 1462 + 0.25, z: "yyyy-mm-dd hh:mm" },
      C1: { t: "n", v: 0.5, z: "hh:mm" },
    };
    const abs1904 = writeOneSheet("vitest-doc-viewer 1904.xlsx", sheet1904, true);
    expect(readImportSyncSheetPreview(abs1904).sheets[0]!.rows).toEqual([["2031-01-05", "2031-01-05 06:00", "12:00"]]);
    const sheet1900: XLSX.WorkSheet = {
      "!ref": "A1:B1",
      A1: { t: "n", v: day1900, z: "yyyy-mm-dd" },
      B1: { t: "n", v: 0.75, z: "hh:mm" },
    };
    const abs1900 = writeOneSheet("vitest-doc-viewer 1900.xlsx", sheet1900);
    expect(readImportSyncSheetPreview(abs1900).sheets[0]!.rows).toEqual([["2031-01-05", "18:00"]]);
  });

  it("takes a sheet's extent from its cells, not its declared dimension, trimming empty columns", () => {
    const abs = writeOneSheet("vitest-doc-viewer far dimension.xlsx", {
      "!ref": "A1:C2",
      A1: { t: "s", v: "Saldo" },
      B2: { t: "n", v: 7 },
      C1: { t: "s", v: "" },
    });
    // Declare the sheet's dimension as the whole grid, as a file may (the writer walks its range).
    const zip = XLSX.CFB.read(fs.readFileSync(abs), { type: "buffer" });
    const entry = XLSX.CFB.find(zip, "/xl/worksheets/sheet1.xml")!;
    const xml = Buffer.from(entry.content as Uint8Array).toString("utf8");
    expect(xml).toMatch(/<dimension ref="A1:C2"\/>/);
    entry.content = Buffer.from(xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>'));
    fs.writeFileSync(abs, XLSX.CFB.write(zip, { type: "buffer", fileType: "zip" }) as Buffer);
    const started = Date.now();
    expect(readImportSyncSheetPreview(abs).sheets[0]!.rows).toEqual([
      ["Saldo", ""],
      ["", 7],
    ]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("answers a preview over the cell limit with a 413", () => {
    const sheet: XLSX.WorkSheet = {
      "!ref": "A1:KO1000",
      A1: { t: "s", v: "first" },
      KO1000: { t: "s", v: "last" },
    };
    const abs = writeOneSheet("vitest-doc-viewer many cells.xlsx", sheet);
    try {
      readImportSyncSheetPreview(abs);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect((e as InstanceType<typeof InputError>).status).toBe(413);
      expect((e as Error).message).toMatch(/301000 cells \(limit 200000\)/);
    }
  });

  it("does not read a workbook over the size limit", () => {
    const { abs_path } = resolveImportSyncDocumentFile(fixtureColumn(), "2031-05");
    try {
      readImportSyncSheetPreview(abs_path);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect((e as InstanceType<typeof InputError>).status).toBe(413);
    }
  });

  it("writes an ASCII filename and the exact name in filename*", () => {
    expect(importSyncDocumentContentDisposition("inline", "2031-02 cartola año (1).pdf")).toBe(
      `inline; filename="2031-02 cartola ano (1).pdf"; filename*=UTF-8''2031-02%20cartola%20a%C3%B1o%20%281%29.pdf`
    );
    expect(importSyncDocumentContentDisposition("attachment", `a"b\\c%€.pdf`)).toBe(
      `attachment; filename="a_b_c__.pdf"; filename*=UTF-8''a%22b%5Cc%25%E2%82%AC.pdf`
    );
  });

  it("ends a failed send by where it failed", () => {
    expect(documentSendFailure({ code: "ECONNABORTED" }, true)).toEqual({ action: "ignore" });
    expect(documentSendFailure({ code: "EIO" }, true)).toEqual({ action: "destroy" });
    expect(documentSendFailure({ code: "ENOENT", status: 404 }, false)).toEqual({ action: "not_found" });
    expect(documentSendFailure({ status: 404 }, false)).toEqual({ action: "not_found" });
    expect(documentSendFailure({ status: 416, headers: { "Content-Range": "bytes */10" } }, false)).toEqual({
      action: "client_error",
      status: 416,
      headers: { "Content-Range": "bytes */10" },
    });
    expect(documentSendFailure({ status: 412 }, false)).toEqual({ action: "client_error", status: 412, headers: {} });
    expect(documentSendFailure({ code: "EACCES" }, false)).toEqual({ action: "fail" });
  });
});

describe("GET /api/import-sync/documents", () => {
  const fileUrl = (month: string, query = "") => `${base}/api/import-sync/documents/${fixtureAccountId}/${month}/file${query}`;

  it("serves the month's file inline or as an attachment, with ranges", async () => {
    const inline = await fetch(fileUrl("2031-02"));
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("application/pdf");
    expect(inline.headers.get("content-disposition")).toBe(importSyncDocumentContentDisposition("inline", PDF_NAME));
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inline.headers.get("cache-control")).toBe("private, no-store");
    expect(inline.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(inline.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect((await inline.text()).startsWith("%PDF-1.4")).toBe(true);

    const download = await fetch(fileUrl("2031-01", "?download=1"));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(download.headers.get("content-disposition")).toBe(importSyncDocumentContentDisposition("attachment", SHEET_FILE));
    await download.arrayBuffer();

    const range = await fetch(fileUrl("2031-02"), { headers: { Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("%PDF");

    const size = fs.statSync(path.join(checkingDir, PDF_NAME)).size;
    const outOfRange = await fetch(fileUrl("2031-02"), { headers: { Range: `bytes=${size + 10}-${size + 20}` } });
    expect(outOfRange.status).toBe(416);
    expect(outOfRange.headers.get("content-range")).toBe(`bytes */${size}`);
    expect(outOfRange.headers.get("content-type")).toMatch(/^application\/json/);
    // Express tags the JSON body with its own weak ETag; the file's headers are gone.
    for (const name of ["content-disposition", "last-modified", "accept-ranges", "cross-origin-resource-policy"]) {
      expect(outOfRange.headers.get(name)).toBeNull();
    }
    expect(typeof ((await outOfRange.json()) as { error?: string }).error).toBe("string");
  });

  it("serves a workbook's cells; a PDF is a 400, a workbook over the limit a 413", async () => {
    const sheet = await fetch(`${base}/api/import-sync/documents/${fixtureAccountId}/2031-01/sheet`);
    expect(sheet.status).toBe(200);
    const body = (await sheet.json()) as { file_name: string; sheets: { name: string; rows: unknown[][] }[] };
    expect(body.file_name).toBe(SHEET_FILE);
    expect(body.sheets.map((s) => s.name)).toEqual(["Movimientos", "Resumen"]);
    expect(body.sheets[0]!.rows[1]).toEqual(["2031-01-05", "Synthetic transfer", 1234.5, "TRUE"]);

    const pdf = await fetch(`${base}/api/import-sync/documents/${fixtureAccountId}/2031-02/sheet`);
    expect(pdf.status).toBe(400);
    expect(((await pdf.json()) as { error: string }).error).toMatch(/not a workbook/);

    const large = await fetch(`${base}/api/import-sync/documents/${fixtureAccountId}/2031-05/sheet`);
    expect(large.status).toBe(413);
    expect(((await large.json()) as { error: string }).error).toMatch(/preview limit/);
  });

  it("answers 400 to a malformed request and 404 to a column or month with no file", async () => {
    const status = async (p: string) => {
      const res = await fetch(`${base}/api/import-sync/documents/${p}`);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      return res.status;
    };
    expect(await status(`0/2031-02/file`)).toBe(400);
    expect(await status(`abc/2031-02/file`)).toBe(400);
    expect(await status(`${fixtureAccountId}/2031-13/file`)).toBe(400);
    expect(await status(`${fixtureAccountId}/2031-02/file?slot=eur`)).toBe(400);
    expect(await status(`${fixtureAccountId}/2031-02/file?slot=usd`)).toBe(400);
    expect(await status(`${fixtureAccountId}/2031-02/file?download=maybe`)).toBe(400);
    expect(await status(`999999999/2031-02/file`)).toBe(404);
    expect(await status(`${fixtureAccountId}/1900-01/file`)).toBe(404);
  });
});
