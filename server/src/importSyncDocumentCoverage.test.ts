import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  isCcStatementPdfSource,
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
} from "./importSyncDocumentMonth.js";
import { buildImportSyncDocumentCoveragePayload } from "./importSyncDocumentCoverage.js";
import { hasImportSyncDocumentForMonth } from "./importSyncDocumentFilePath.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

describe("importSyncDocumentCoverage", () => {
  it("returns matrix shape consistent with months and accounts", () => {
    const payload = buildImportSyncDocumentCoveragePayload({ validateCcMetadata: false });
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
    const payload = buildImportSyncDocumentCoveragePayload({ validateCcMetadata: false });
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
              `SELECT source_pdf, period_to FROM cc_statements WHERE account_id = ?`
            )
            .all(acc.account_id) as {
              source_pdf: string;
              period_to: string | null;
            }[];
          const row = rows.find((r) => matrixMonthForCcStatement(r) === rowMonth);
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
