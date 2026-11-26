import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { installmentPurchaseSiblingStatementLines } from "./ccExpenseCategories.js";
import { db } from "./db.js";

/**
 * The lines a category spreads to from one installment line: a ledger-linked cuota line names its
 * plan's lines; a line with no ledger link (a statement's 00/N row) takes the lines that look like
 * its purchase only while they belong to one plan — never a second plan at the same merchant.
 */

const PREFIX = "vitest-sibling-lines";
let ccId: number | null = null;
let stmt00: number | null = null;
let stmtCuotas: number | null = null;

function line(statementId: number, opts: { prid: string; cur: number; amount: number; cuota: number }): number {
  return Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, cuota_amount, installment_flag,
           nro_cuota_current, nro_cuota_total, dedupe_key, parser_row_id)
         VALUES (?, '05/06/2026', 'TIENDA CUOTAS VITEST', ?, ?, 1, ?, 3, ?, ?)`
      )
      .run(statementId, opts.amount, opts.cuota, opts.cur, `${PREFIX}-${opts.prid}`, `${PREFIX}-${opts.prid}`).lastInsertRowid
  );
}

function plan(total: number, cuotaLinePrid: string, cuota: number): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO cc_installment_purchases (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
           cuotas_totales, merchant, description_merged, source)
         VALUES (?, 'A', ?, '2026-06-05', ?, 3, 'TIENDA CUOTAS VITEST', 'TIENDA CUOTAS VITEST', 'pdf')`
      )
      .run(ccId, `${PREFIX}-${total}`, total).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf,
       amount_clp, cuota_current, cuota_total, parser_row_id)
     VALUES (?, '2026-08-10', '24/07/2026', '2026-07', ?, ?, 1, 3, ?)`
  ).run(id, `${PREFIX}-jul.pdf`, cuota, `${PREFIX}-${cuotaLinePrid}`);
  return id;
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) throw new Error("no credit-card asset group in the test database");
  ccId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · sibling lines card', ?, ?)`)
      .run(leaf.id, PREFIX, PREFIX).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7774', 21, 20, 'santander')`
  ).run(ccId);
  const st = db.prepare(
    `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
     VALUES (?, 'A', ?, ?, ?, ?, 'clp')`
  );
  stmt00 = Number(st.run(ccId, `${PREFIX}-jun.pdf`, "24/06/2026", "26/05/2026", "24/06/2026").lastInsertRowid);
  stmtCuotas = Number(st.run(ccId, `${PREFIX}-jul.pdf`, "24/07/2026", "25/06/2026", "24/07/2026").lastInsertRowid);
});

afterEach(() => {
  db.prepare(
    `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
  ).run(ccId);
  db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (?, ?)`).run(stmt00, stmtCuotas);
  clearAggregationCache();
});

afterAll(() => {
  if (ccId == null) return;
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(ccId, ccId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  clearAggregationCache();
});

describe("installmentPurchaseSiblingStatementLines", () => {
  it("spreads a 00/N row over its one plan's lines", () => {
    const row00 = line(stmt00!, { prid: "00", cur: 0, amount: 300_000, cuota: 100_000 });
    const cuota1 = line(stmtCuotas!, { prid: "a1", cur: 1, amount: 100_000, cuota: 100_000 });
    plan(300_000, "a1", 100_000);
    clearAggregationCache();
    expect(installmentPurchaseSiblingStatementLines(row00)).toEqual({ line_ids: [row00, cuota1], ambiguous_plan_ids: null });
    // A ledger-linked cuota line names its plan's lines.
    expect(installmentPurchaseSiblingStatementLines(cuota1)).toEqual({ line_ids: [cuota1], ambiguous_plan_ids: null });
  });

  it("spreads nothing from a 00/N row whose look-alikes belong to two plans of different totals", () => {
    const row00 = line(stmt00!, { prid: "00", cur: 0, amount: 300_000, cuota: 100_000 });
    const a1 = line(stmtCuotas!, { prid: "a1", cur: 1, amount: 100_000, cuota: 100_000 });
    const b1 = line(stmtCuotas!, { prid: "b1", cur: 1, amount: 100_300, cuota: 100_300 });
    const planA = plan(300_000, "a1", 100_000);
    const planB = plan(300_900, "b1", 100_300);
    clearAggregationCache();
    expect(installmentPurchaseSiblingStatementLines(row00)).toEqual({
      line_ids: [row00],
      ambiguous_plan_ids: [planA, planB].sort((x, y) => x - y),
    });
    // Each cuota line still reaches only its own plan.
    expect(installmentPurchaseSiblingStatementLines(a1).line_ids).toEqual([a1]);
    expect(installmentPurchaseSiblingStatementLines(b1).line_ids).toEqual([b1]);
  });
});
