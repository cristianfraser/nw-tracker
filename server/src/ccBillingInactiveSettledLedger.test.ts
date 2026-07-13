import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { creditCardBillingDetailInactive } from "./ccBillingInactive.js";

/**
 * A card whose installment ledger is fully settled (all cuotas billed long ago, $0 live
 * outstanding, no statements this cycle) must be inactive — the ledger-rows short-circuit
 * used to keep it "active" forever, and the open-month rollforward then resurrected the
 * last pre-settlement statement balance as a live debt (·1617 regression: $17.530).
 */
describe("creditCardBillingDetailInactive with an installment ledger", () => {
  const insertedStatementIds: number[] = [];
  const insertedPurchaseIds: number[] = [];

  afterEach(() => {
    if (insertedStatementIds.length > 0) {
      const phs = insertedStatementIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM cc_statements WHERE id IN (${phs})`).run(...insertedStatementIds);
      insertedStatementIds.length = 0;
    }
    if (insertedPurchaseIds.length === 0) return;
    const ph = insertedPurchaseIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (${ph})`).run(...insertedPurchaseIds);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE id IN (${ph})`).run(...insertedPurchaseIds);
    insertedPurchaseIds.length = 0;
  });

  function fixtureMasterId(): number | null {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    return master?.id ?? null;
  }

  function insertStatement(accountId: number, name: string, ddmmyyyy: string) {
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'A', ?, ?, ?, ?)`
    ).run(accountId, name, ddmmyyyy, ddmmyyyy, ddmmyyyy);
    insertedStatementIds.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  }

  function insertPlan(accountId: number, canonicalId: string, paidCuotas: number, totalCuotas: number) {
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', ?, NULL, NULL, NULL, '2020-01-05', 30000, ?, 'VITEST INACTIVE', 'VITEST INACTIVE', NULL, 'pdf')`
    ).run(accountId, canonicalId, totalCuotas);
    const pid = (
      db.prepare(
        `SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = ?`
      ).get(accountId, canonicalId) as { id: number }
    ).id;
    insertedPurchaseIds.push(pid);
    const ins = db.prepare(
      `INSERT INTO cc_installment_payments (
         purchase_id, pay_by_date, statement_date, statement_period_month, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
       ) VALUES (?, ?, ?, ?, 'vitest-inactive.pdf', 10000, ?, ?, NULL)`
    );
    for (let k = 1; k <= paidCuotas; k++) {
      const mm = String(k).padStart(2, "0");
      ins.run(pid, `2020-${mm}-25`, `20/${mm}/2020`, `2020-${mm}`, k, totalCuotas);
    }
  }

  it("is inactive when every plan is settled and the last statement is long past", () => {
    const master = fixtureMasterId();
    if (!master) return;
    insertStatement(master, "vitest-inactive-old.pdf", "20/03/2020");
    insertPlan(master, "inactive-settled", 3, 3);
    expect(creditCardBillingDetailInactive(master)).toBe(true);
  });

  it("stays active while a plan has outstanding cuotas", () => {
    const master = fixtureMasterId();
    if (!master) return;
    insertStatement(master, "vitest-inactive-old.pdf", "20/03/2020");
    insertPlan(master, "inactive-outstanding", 1, 3);
    expect(creditCardBillingDetailInactive(master)).toBe(false);
  });
});
