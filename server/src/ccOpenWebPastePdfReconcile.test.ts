import { afterAll, beforeEach, describe, expect, it, afterEach } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import { reconcileOpenWebPasteAfterPdfClose } from "./ccOpenWebPastePdfReconcile.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

describe("reconcileOpenWebPasteAfterPdfClose", () => {
  let accountId = 0;

  beforeEach(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "4242", key: "vitest-pdf-reconcile" });
  });

  afterEach(() => {
    deleteTempCardMaster(accountId);
  });

  function insertStatement(sourcePdf: string, period: { from: string | null; to: string | null }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency
           ) VALUES (?, 'santander', ?, '20/05/2026', ?, ?, '4242', 'compact', 'clp')`
        )
        .run(accountId, sourcePdf, period.from, period.to).lastInsertRowid
    );
  }

  function insertLine(statementId: number, ddMmYyyy: string, merchant: string, amount: number): number {
    const dedupe = `vitest-pdf-reconcile-${statementId}-${merchant}`;
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (
             statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line
           ) VALUES (?, ?, ?, ?, 0, ?, ?, 'raw')`
        )
        .run(statementId, ddMmYyyy, merchant, amount, dedupe, dedupe).lastInsertRowid
    );
  }

  const lineExists = (id: number) => db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(id) !== undefined;

  it("deletes matched web-paste one-shots on open bucket when PDF closed month exists", () => {
    const pdf = insertStatement("vitest 2026-05-20 clp.pdf", { from: "21/04/2026", to: "20/05/2026" });
    insertLine(pdf, "10/05/2026", "ACME STORE", 10_000);
    const bucket = insertStatement(openWebPasteSourcePdf("2026-05"), { from: null, to: null });
    const matched = insertLine(bucket, "10/05/2026", "ACME STORE", 10_000);

    // A dry run reports the line and writes nothing.
    const dry = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-05", { dryRun: true });
    expect(dry.skipped).toBe(false);
    expect(dry.deleted_line_ids).toEqual([matched]);
    expect(lineExists(matched)).toBe(true);

    const applied = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-05");
    expect(applied.deleted_line_ids).toEqual([matched]);
    expect(applied.deleted_count).toBe(1);
    expect(applied.moved_line_ids).toEqual([]);
    expect(applied.annulled_line_ids).toEqual([]);
    expect(lineExists(matched)).toBe(false);
  });

  it("skips a month with no closed statement", () => {
    const bucket = insertStatement(openWebPasteSourcePdf("2026-05"), { from: null, to: null });
    const line = insertLine(bucket, "10/05/2026", "ACME STORE", 10_000);
    const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-05");
    expect(result.skipped).toBe(true);
    expect(result.skip_reason).toBe("no_pdf_lines_for_billing_month");
    expect(lineExists(line)).toBe(true);
  });
});
