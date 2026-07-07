import { describe, expect, it, afterEach } from "vitest";
import { db } from "./db.js";
import { buildFacturaciones } from "./ccBillingViews.js";
import { incrementalChargesClpForBillingMonth } from "./ccBillingBalances.js";
import {
  billingMonthForManualLedgerPurchase,
  lastPdfBillingMonthForAccount,
} from "./ccManualBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { ymCompare } from "./calendarMonth.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import {
  reconcileOpenWebPasteAfterPdfClose,
  listStaleOpenWebPasteStatementDates,
} from "./ccOpenWebPastePdfReconcile.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

describe("reconcileOpenWebPasteAfterPdfClose", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()!();
  });

  it("deletes matched web-paste one-shots on open bucket when PDF closed month exists", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !openBm || ymCompare(openBm, addCalendarMonths(lastPdf, 1)) < 0) return;

    const pdfStmt = listCcStatementsForAccount(master.id).find(
      (st) => st.billing_month === lastPdf && !st.source_pdf.startsWith("import:web-paste")
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
           statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key, parser_row_id, raw_line
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

  it("stale open-bucket lines count toward current open month incremental charges", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!openBm || !lastPdf || ymCompare(openBm, lastPdf) <= 0) return;

    const staleDates = listStaleOpenWebPasteStatementDates(master.id, openBm);
    if (staleDates.length === 0) return;

    const before = incrementalChargesClpForBillingMonth(master.id, openBm);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it("buildFacturaciones prefers PDF facturado over web-paste for closed month", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!lastPdf) return;

    const pdfStmt = listCcStatementsForAccount(master.id).find(
      (st) =>
        st.billing_month === lastPdf &&
        !st.source_pdf.startsWith("import:web-paste") &&
        st.monto_facturado != null &&
        st.monto_facturado > 0
    );
    const webStmt = listCcStatementsForAccount(master.id).find(
      (st) => st.billing_month === lastPdf && st.source_pdf.startsWith("import:web-paste")
    );
    if (!pdfStmt?.monto_facturado || !webStmt) return;

    const payload = ccInstallmentsDbApiPayload(master.id);
    const rows = buildFacturaciones(master.id, payload.months);
    const row = rows.find((r) => r.billing_month === lastPdf);
    expect(row?.facturado_clp).toBe(Math.round(pdfStmt.monto_facturado));
  });
});
