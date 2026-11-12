import { describe, expect, it, afterEach } from "vitest";
import { db } from "./db.js";
import { ymCompare } from "./calendarMonth.js";
import { billingMonthForManualLedgerPurchase, closeEvidenceForBillingMonth, lastPdfBillingMonthForAccount } from "./cards/facturacion.js";
import {
  openWebPasteSourcePdf,
  parseOpenWebPasteBillingMonth,
  repairMisplacedOpenWebPasteBuckets,
} from "./ccOpenWebPasteRepair.js";
import { addCalendarMonths } from "nw-tracker-contracts";

describe("repairMisplacedOpenWebPasteBuckets", () => {
  let lineId: number | null = null;
  let stmtId: number | null = null;

  afterEach(() => {
    if (lineId != null) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(lineId);
    }
    if (stmtId != null) {
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(stmtId);
    }
    lineId = null;
    stmtId = null;
  });

  it("moves post-close web-paste lines from stale open bucket to current open month", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number };

    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !openBm) return;
    expect(ymCompare(openBm, addCalendarMonths(lastPdf, 1))).toBeGreaterThanOrEqual(0);

    const periodTo = closeEvidenceForBillingMonth(master.id, lastPdf).close_iso;
    if (!periodTo) return;

    const staleBm = lastPdf;
    if (staleBm === openBm) return;

    const ins = db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, card_last4, layout, currency
       ) VALUES (?, 'santander', ?, '20/05/2026', '4242', 'compact', 'clp')`
    );
    const r = ins.run(master.id, openWebPasteSourcePdf(staleBm));
    stmtId = Number(r.lastInsertRowid);

    const [y, mo, d] = periodTo.split("-").map(Number) as [number, number, number];
    const postClose = new Date(Date.UTC(y, mo - 1, d + 3));
    const ddMm = `${postClose.getUTCDate()}/${postClose.getUTCMonth() + 1}/${postClose.getUTCFullYear()}`;

    const insLine = db.prepare(
      `INSERT INTO cc_statement_lines (
         statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line
       ) VALUES (?, ?, 'Vitest repair post-close', 5000, 0, ?, ?, 'raw')`
    );
    const dedupe = `vitest-repair-${Date.now()}`;
    const lr = insLine.run(stmtId, ddMm, dedupe, dedupe);
    lineId = Number(lr.lastInsertRowid);

    const repaired = repairMisplacedOpenWebPasteBuckets(master.id);
    expect(repaired.lines_moved).toBeGreaterThanOrEqual(1);

    const moved = db
      .prepare(`SELECT statement_id FROM cc_statement_lines WHERE id = ?`)
      .get(lineId) as { statement_id: number };
    const targetStmt = db
      .prepare(`SELECT source_pdf FROM cc_statements WHERE id = ?`)
      .get(moved.statement_id) as { source_pdf: string };
    expect(parseOpenWebPasteBillingMonth(targetStmt.source_pdf)).toBe(openBm);
  });
});
