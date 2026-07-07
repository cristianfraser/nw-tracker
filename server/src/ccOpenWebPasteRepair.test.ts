import { describe, expect, it, afterEach } from "vitest";
import { db } from "./db.js";
import { ymCompare } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  billingMonthForManualLedgerPurchase,
  lastPdfBillingMonthForAccount,
  periodToIsoForBillingMonth,
} from "./ccManualBillingMonth.js";
import {
  openWebPasteSourcePdf,
  parseOpenWebPasteBillingMonth,
  repairMisplacedOpenWebPasteBuckets,
} from "./ccOpenWebPasteRepair.js";
import { buildProjectedReconcileRows, reconcileBillingMonthMovements } from "./ccStatementImportReconcile.js";

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
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !openBm) return;
    expect(ymCompare(openBm, addCalendarMonths(lastPdf, 1))).toBeGreaterThanOrEqual(0);

    const periodTo = periodToIsoForBillingMonth(master.id, lastPdf);
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
         statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key, parser_row_id, raw_line
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

  it("PDF reconcile ignores stale open-bucket post-close lines in DB", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const st = db
      .prepare(
        `SELECT source_pdf, monto_facturado, compras_cargos FROM cc_statements
         WHERE account_id = ? AND source_pdf NOT LIKE 'import:web-paste%'
           AND monto_facturado IS NOT NULL AND monto_facturado > 0
         ORDER BY statement_date DESC LIMIT 1`
      )
      .get(master.id) as
      | {
          source_pdf: string;
          monto_facturado: number | null;
          compras_cargos: number | null;
        }
      | undefined;
    if (!st?.monto_facturado) return;

    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!lastPdf) return;

    const rows = buildProjectedReconcileRows(master.id, lastPdf, [], new Set(), {
      pdfReconcileOnly: true,
    });
    const result = reconcileBillingMonthMovements(lastPdf, rows, {
      monto_facturado: st.monto_facturado,
      compras_cargos: st.compras_cargos,
      source_pdf: st.source_pdf,
    });
    expect(result.ok).toBe(true);
  });
});
