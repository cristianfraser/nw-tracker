import { afterAll, describe, expect, it, afterEach } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { billingMonthForManualLedgerPurchase, lastPdfBillingMonthForAccount } from "./cards/facturacion.js";
import { ymCompare } from "./calendarMonth.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import { reconcileOpenWebPasteAfterPdfClose } from "./ccOpenWebPastePdfReconcile.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { addCalendarMonths } from "nw-tracker-contracts";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_balances"]);
afterAll(() => restoreDerivedCardState());

describe("reconcileOpenWebPasteAfterPdfClose", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()!();
  });

  it("deletes matched web-paste one-shots on open bucket when PDF closed month exists", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number };

    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !openBm || ymCompare(openBm, addCalendarMonths(lastPdf, 1)) < 0) return;

    const pdfStmt = listCcStatementsForAccount(master.id).find(
      (st) => st.billing_month === lastPdf && st.source_kind !== "listing_open"
    );
    if (!pdfStmt) return;

    const pdfLine = db
      .prepare(
        `SELECT l.id, l.merchant, l.amount_clp, l.transaction_date, l.posting_date
         FROM cc_statement_lines l
         WHERE l.statement_id = ? AND l.installment_flag = 0 AND l.amount_clp > 0
         LIMIT 1`
      )
      .get(pdfStmt.id) as
      | {
          id: number;
          merchant: string | null;
          amount_clp: number | null;
          transaction_date: string | null;
          posting_date: string | null;
        }
      | undefined;
    if (!pdfLine?.amount_clp) return;

    const openSource = openWebPasteSourcePdf(lastPdf);
    let webStmt = listCcStatementsForAccount(master.id).find((st) => st.source_pdf === openSource);
    if (!webStmt) {
      const ins = db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, card_last4, layout, currency
           ) VALUES (?, 'santander', ?, '20/05/2026', '4242', 'compact', 'clp')`
        )
        .run(master.id, openSource);
      webStmt = listCcStatementsForAccount(master.id).find(
        (st) => st.id === Number(ins.lastInsertRowid)
      );
      cleanup.push(() => db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(ins.lastInsertRowid));
    }
    if (!webStmt) return;

    const dedupe = `vitest-pdf-reconcile-${Date.now()}`;
    const insLine = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line
         ) VALUES (?, ?, ?, ?, 0, ?, ?, 'raw')`
      )
      .run(
        webStmt.id,
        pdfLine.transaction_date ?? pdfLine.posting_date ?? "01/06/2026",
        pdfLine.merchant ?? "VITEST MATCH",
        pdfLine.amount_clp,
        dedupe,
        dedupe
      );
    const webLineId = Number(insLine.lastInsertRowid);
    cleanup.push(() => db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(webLineId));

    const dry = reconcileOpenWebPasteAfterPdfClose(master.id, lastPdf, { dryRun: true });
    expect(dry.deleted_line_ids).toContain(webLineId);

    const applied = reconcileOpenWebPasteAfterPdfClose(master.id, lastPdf);
    expect(applied.deleted_line_ids).toContain(webLineId);
    cleanup.pop();

    const gone = db.prepare(`SELECT id FROM cc_statement_lines WHERE id = ?`).get(webLineId);
    expect(gone).toBeUndefined();
  });
});
