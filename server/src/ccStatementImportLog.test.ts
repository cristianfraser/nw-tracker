import { describe, expect, it } from "vitest";
import {
  buildCcStatementImportAccountLog,
  formatCcStatementImportLogBody,
} from "./ccStatementImportLog.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";

describe("ccStatementImportLog", () => {
  it("lists PDFs and warnings when no lines inserted", () => {
    const records: CcStatementCsvRecord[] = [
      {
        source_pdf: "2021-09-22 estado de cuenta tarjeta usd 4141.pdf",
        card_last4: "4141",
        currency: "usd",
        parser_layout: "international_usd",
        statement_date: "22/09/2021",
      },
    ];
    const acc = buildCcStatementImportAccountLog(35, "4141 santander", records, {
      statements_merged: 0,
      lines_inserted: 0,
      lines_skipped_duplicate: 0,
      lines_skipped_installment_overlap: 0,
      purchase_upserts: 0,
      payment_upserts: 0,
    });
    expect(acc.warnings.some((w) => w.includes("no statement lines inserted"))).toBe(true);
    const body = formatCcStatementImportLogBody({ dry_run: false, accounts: [acc] });
    expect(body).toContain("2021-09-22 estado de cuenta tarjeta usd 4141.pdf");
  });
});
