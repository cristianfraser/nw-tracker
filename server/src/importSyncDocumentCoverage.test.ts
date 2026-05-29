import path from "node:path";
import { describe, expect, it } from "vitest";
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
  });

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
  });

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
            .get(acc.account_id, rowMonth) as { period_month: string; source_file: string } | undefined;
          expect(row).toBeDefined();
          expect(path.basename(row!.source_file)).toBe(base);
          expect(matrixMonthForCartolaPeriodMonth(row!.period_month)).toBe(rowMonth);
        }
      }
    }
  });
});
