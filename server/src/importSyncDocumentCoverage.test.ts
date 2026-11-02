import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  isCcStatementPdfSource,
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
} from "./importSyncDocumentMonth.js";
import { buildImportSyncDocumentCoveragePayload } from "./importSyncDocumentCoverage.js";
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

  it("CC check uses period_to month", () => {
    const ccIds = listCreditCardMasterAccountIds();
    if (ccIds.length === 0) return;

    const accountId = ccIds[0]!;
    const stmt = db
      .prepare(
        `SELECT period_to, source_pdf FROM cc_statements
         WHERE account_id = ?
         ORDER BY id DESC`
      )
      .all(accountId) as { period_to: string; source_pdf: string }[];
    const pdfStmt = stmt.find((s) => isCcStatementPdfSource(s.source_pdf));
    if (!pdfStmt) return;

    const ym = matrixMonthForCcStatement(pdfStmt);
    if (!ym) return;

    const acc = { account_id: accountId, label: "", document_kind: "cc_statement" as const };
    expect(hasImportSyncDocumentForMonth(acc, ym)).toBe(true);
  });

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
              `SELECT source_pdf, period_to, currency, layout FROM cc_statements WHERE account_id = ?`
            )
            .all(acc.account_id) as {
              source_pdf: string;
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

  it("does not mark cuenta vista multi-month cells sin-mov when PDF has imported movements", () => {
    const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
    if (vistaId == null) return;

    const hasMultiMonth = db
      .prepare(
        `SELECT 1 FROM checking_cartola_imports
         WHERE account_id = ? AND source_file = '2017-10-31 cartola cuenta vista.pdf'
           AND movement_count > 0 LIMIT 1`
      )
      .get(vistaId);
    if (!hasMultiMonth) return;

    const payload = coveragePayload();
    if (!payload) return;

    const accIdx = payload.accounts.findIndex(
      (a) => a.account_id === vistaId && a.document_kind === "cuenta_vista_cartola"
    );
    if (accIdx < 0) return;

    for (let mi = 0; mi < payload.months.length; mi += 1) {
      const rowMonth = payload.months[mi]!;
      if (rowMonth < "2016-10" || rowMonth > "2017-09") continue;
      const cell = payload.cells[mi]?.[accIdx];
      if (!cell?.imported) continue;
      if (!cell.file_path?.includes("2017-10-31 cartola cuenta vista.pdf")) continue;
      expect(cell.file_sin_movimientos).not.toBe(true);
    }
  }, 20_000);
});
