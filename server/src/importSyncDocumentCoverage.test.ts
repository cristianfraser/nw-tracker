import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
} from "./importSyncDocumentMonth.js";
import { buildImportSyncDocumentCoveragePayload, buildImportSyncDocumentYears } from "./importSyncDocumentCoverage.js";
import {
  CcStatementPdfPathError,
  ccCreditCardAccountHasUsdStatements,
  hasImportSyncDocumentForMonth,
  isCcUsdStatementRow,
} from "./importSyncDocumentFilePath.js";

function coveragePayload() {
  try {
    return buildImportSyncDocumentCoveragePayload({ validateCcMetadata: false });
  } catch (e) {
    if (e instanceof CcStatementPdfPathError) return null;
    throw e;
  }
}
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

/**
 * Coverage looks for each document on disk. The test database is synthetic, so the folders are
 * pointed at a temporary directory holding an empty file for every cartola it imported — never at
 * the real `cfraser/`, whose files belong to another database.
 */
const DOCUMENT_DIR_ENV = [
  "CFRASER_PDFS_DIR",
  "CFRASER_CHECKING_CARTOLAS_DIR",
  "CFRASER_CHECKING_CARTOLA_PDFS_DIR",
  "CFRASER_CUENTA_VISTA_PDFS_DIR",
] as const;
let documentRoot: string | null = null;

/** A blank one-page PDF, so the coverage's `pdftotext` peek reads it without complaint. */
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
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  documentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nw-import-sync-coverage-"));
  for (const key of DOCUMENT_DIR_ENV) {
    savedEnv.set(key, process.env[key]);
    const dir = path.join(documentRoot, key);
    fs.mkdirSync(dir);
    process.env[key] = dir;
  }
  const pdf = blankPdf();
  const rows = db
    .prepare(`SELECT DISTINCT source_file FROM checking_cartola_imports`)
    .all() as { source_file: string }[];
  for (const { source_file } of rows) {
    if (!source_file || source_file.startsWith("screenshot:")) continue;
    for (const key of ["CFRASER_CHECKING_CARTOLA_PDFS_DIR", "CFRASER_CUENTA_VISTA_PDFS_DIR"]) {
      fs.writeFileSync(path.join(process.env[key]!, path.basename(source_file)), pdf);
    }
  }
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (documentRoot) fs.rmSync(documentRoot, { recursive: true, force: true });
});

describe("importSyncDocumentCoverage", () => {
  it("returns matrix shape consistent with months and accounts", () => {
    const payload = coveragePayload();
    if (!payload) return;
    expect(payload.months.length).toBeGreaterThan(0);
    expect(payload.accounts.length).toBeGreaterThan(0);
    expect(payload.cells.length).toBe(payload.months.length);
    for (const row of payload.cells) {
      expect(row.length).toBe(payload.accounts.length);
    }
    const currentYm = monthKeyFromYmd(chileCalendarTodayYmd());
    expect(payload.months[0]).toBe(currentYm);
  }, 20_000);

  it("cartola check uses period_month exactly", () => {
    const checkingId = cartolaCashAccountIdOptional("cuenta_corriente");
    if (checkingId == null) return;

    const row = db
      .prepare(
        `SELECT period_month FROM checking_cartola_imports WHERE account_id = ? ORDER BY period_month DESC LIMIT 1`
      )
      .get(checkingId) as { period_month: string } | undefined;
    if (!row) return;

    const acc = { account_id: checkingId, label: "", document_kind: "checking_cartola" as const };
    expect(hasImportSyncDocumentForMonth(acc, row.period_month)).toBe(true);
  });

  it("emits CLP and USD columns for cards with USD statements", () => {
    const payload = coveragePayload();
    if (!payload) return;
    for (const accountId of listCreditCardMasterAccountIds()) {
      const cols = payload.accounts.filter((a) => a.account_id === accountId);
      if (ccCreditCardAccountHasUsdStatements(accountId)) {
        expect(cols).toHaveLength(2);
        expect(cols.map((c) => c.cc_statement_currency).sort()).toEqual(["clp", "usd"]);
      } else {
        expect(cols).toHaveLength(1);
        expect(cols[0]?.cc_statement_currency).toBeUndefined();
      }
    }
  }, 20_000);

  it("links source_file for the same row_month as period_month / period_to", () => {
    const payload = coveragePayload();
    if (!payload) return;
    let cartolaCellsMatched = 0;
    for (let mi = 0; mi < payload.months.length; mi += 1) {
      const rowMonth = payload.months[mi]!;
      for (let ai = 0; ai < payload.accounts.length; ai += 1) {
        const cell = payload.cells[mi]?.[ai];
        if (!cell?.imported || !cell.file_path) continue;
        const acc = payload.accounts[ai]!;
        expect(hasImportSyncDocumentForMonth(acc, rowMonth)).toBe(true);
        const base = path.basename(cell.file_path);
        if (acc.document_kind === "cc_statement") {
          const rows = db
            .prepare(
              `SELECT source_pdf, source_kind, period_to, currency, layout FROM cc_statements WHERE account_id = ?`
            )
            .all(acc.account_id) as {
              source_pdf: string;
              source_kind: string;
              period_to: string | null;
              currency: string;
              layout?: string | null;
            }[];
          const row = rows.find((r) => {
            if (matrixMonthForCcStatement(r) !== rowMonth) return false;
            if (acc.cc_statement_currency === "usd") return isCcUsdStatementRow(r);
            if (acc.cc_statement_currency === "clp") return !isCcUsdStatementRow(r);
            return true;
          });
          expect(row).toBeDefined();
          expect(matrixMonthForCcStatement(row!)).toBe(rowMonth);
        } else {
          const row = db
            .prepare(
              `SELECT period_month, source_file FROM checking_cartola_imports
               WHERE account_id = ? AND period_month = ?`
            )
            .get(acc.account_id, rowMonth) as
            | { period_month: string; source_file: string }
            | undefined;
          if (row) {
            // Synthetic registry rows (screenshot:/web-paste imports) don't reference a
            // document on disk — coverage cells for them can't be matched by basename.
            if (row.source_file.startsWith("screenshot:")) continue;
            expect(path.basename(row.source_file)).toBe(base);
            expect(matrixMonthForCartolaPeriodMonth(row.period_month)).toBe(rowMonth);
            cartolaCellsMatched += 1;
          } else {
            expect(cell.imported).toBe(true);
          }
        }
      }
    }
    expect(cartolaCellsMatched).toBeGreaterThan(0);
  }, 20_000);
});

describe("buildImportSyncDocumentYears", () => {
  const cell = (imported: boolean, file_path: string | null = null, file_sin_movimientos = false) => ({ imported, file_path, file_sin_movimientos });

  it("leaves the months before a column's first document out and adds each year up", () => {
    // Newest first. Column 0 starts in 2030-11; column 1 has a hole in 2031-01 and a file never imported.
    const months = ["2031-02", "2031-01", "2030-12", "2030-11", "2030-10"];
    const { cells, years } = buildImportSyncDocumentYears(months, 2, [
      [cell(false), cell(false, "/synthetic/b-2031-02.pdf")],
      [cell(true, "/synthetic/a-2031-01.pdf"), cell(false)],
      [cell(true), cell(true, "/synthetic/b-2030-12.pdf", true)],
      [cell(true, "/synthetic/a-2030-11.pdf"), cell(true, "/synthetic/b-2030-11.pdf")],
      [cell(false), cell(true, "/synthetic/b-2030-10.pdf")],
    ], "2031-03");
    expect(cells.map((row) => row.map((c) => c.state))).toEqual([
      ["missing", "file_not_imported"],
      ["imported", "missing"],
      ["imported_no_file", "no_movements"],
      ["imported", "imported"],
      ["before_first", "imported"],
    ]);
    expect(years).toEqual([
      { year: 2031, month_indexes: [0, 1], columns: [{ counted: 2, imported: 1 }, { counted: 2, imported: 0 }], columns_counted: 2, columns_complete: 0, incomplete_columns: [0, 1] },
      { year: 2030, month_indexes: [2, 3, 4], columns: [{ counted: 2, imported: 2 }, { counted: 3, imported: 3 }], columns_counted: 2, columns_complete: 2, incomplete_columns: [] },
    ]);
  });

  it("does not count the month in progress while its document is not there", () => {
    // Column 0 has nothing for the current month yet; column 1's statement already arrived.
    const { cells, years } = buildImportSyncDocumentYears(
      ["2031-02", "2031-01"],
      2,
      [
        [cell(false), cell(true, "/synthetic/b-2031-02.pdf")],
        [cell(true, "/synthetic/a-2031-01.pdf"), cell(true, "/synthetic/b-2031-01.pdf")],
      ],
      "2031-02"
    );
    expect(cells[0]!.map((c) => c.state)).toEqual(["not_due", "imported"]);
    expect(years).toEqual([
      { year: 2031, month_indexes: [0, 1], columns: [{ counted: 1, imported: 1 }, { counted: 2, imported: 2 }], columns_counted: 2, columns_complete: 2, incomplete_columns: [] },
    ]);
  });

  it("keeps a year whose only month is the one in progress, with nothing due", () => {
    // January: neither column has its document yet; both have documents in earlier years.
    const { cells, years } = buildImportSyncDocumentYears(
      ["2031-01", "2030-12"],
      2,
      [
        [cell(false), cell(false)],
        [cell(true, "/synthetic/a-2030-12.pdf"), cell(true, "/synthetic/b-2030-12.pdf")],
      ],
      "2031-01"
    );
    expect(cells[0]!.map((c) => c.state)).toEqual(["not_due", "not_due"]);
    expect(years[0]).toEqual({
      year: 2031,
      month_indexes: [0],
      columns: [{ counted: 0, imported: 0 }, { counted: 0, imported: 0 }],
      columns_counted: 0,
      columns_complete: 0,
      incomplete_columns: [],
    });
  });

  it("reads a cartola with no movements that was never imported as not imported", () => {
    const { cells } = buildImportSyncDocumentYears(
      ["2031-01"],
      1,
      [[{ imported: false, file_path: "/synthetic/a-2031-01.pdf", file_sin_movimientos: true }]],
      "2031-02"
    );
    expect(cells[0]![0]!.state).toBe("file_not_imported");
  });

  it("gives a column with no document at all no counted month", () => {
    const { cells, years } = buildImportSyncDocumentYears(["2031-01"], 1, [[cell(false)]], "2031-01");
    expect(cells[0]![0]!.state).toBe("before_first");
    expect(years).toEqual([{ year: 2031, month_indexes: [0], columns: [null], columns_counted: 0, columns_complete: 0, incomplete_columns: [] }]);
  });
});
