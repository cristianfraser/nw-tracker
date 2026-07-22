import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { ccFinancingCostClpBetween, ccFinancingCostClpByDate } from "./ccFinancingCostDaily.js";
import { db } from "./db.js";

/**
 * A card's P/L is what the bank charged it: section-3 lines (intereses, comisiones,
 * impuestos) are financing cost; purchases, payments and refunds are capital flow. Fixture
 * dates live in 2037 so they cannot collide with synthetic-DB data.
 */

let ccId: number | null = null;
let statementId: number | null = null;

beforeAll(() => {
  const ccLeaf = db
    .prepare(
      `SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!ccLeaf) return;

  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
         VALUES (?, 'Vitest · cc-financing card', 'vitest-ccfin', 'vitest-ccfin', 'master')`
      )
      .run(ccLeaf.id).lastInsertRowid
  );
  statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', 'vitest-ccfin.pdf', '22/04/2037', '25/03/2037', '22/04/2037', 'clp')`
      )
      .run(ccId).lastInsertRowid
  );
  const insLine = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  insLine.run(statementId, "05/04/2037", "SUPERMERCADO X", 45000, "vitest-ccfin-buy");
  insLine.run(statementId, "12/04/2037", "INTERESES", 8300, "vitest-ccfin-int");
  insLine.run(statementId, "12/04/2037", "IMPTO. DECRETO LEY 3475", 1200, "vitest-ccfin-tax");
  insLine.run(statementId, "15/04/2037", "MONTO CANCELADO", -50000, "vitest-ccfin-pago");
  insLine.run(statementId, "18/04/2037", "NOTA DE CREDITO SUPERMERCADO X", -4500, "vitest-ccfin-nota");
  clearAggregationCache();
});

afterAll(() => {
  if (statementId != null) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  }
  if (ccId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  clearAggregationCache();
});

describe("ccFinancingCostClpByDate", () => {
  it("counts only the bank's charges — purchases, payments and refunds are flow", () => {
    if (ccId == null) return;
    const byDate = ccFinancingCostClpByDate(ccId);
    // Intereses + impuesto share a charge date and add up.
    expect(byDate.get("2037-04-12")).toBe(9500);
    expect(byDate.get("2037-04-05")).toBeUndefined();
    expect(byDate.get("2037-04-15")).toBeUndefined();
    // A NOTA DE CREDITO matches the section-3 merchant patterns but is a refund, not a cost.
    expect(byDate.get("2037-04-18")).toBeUndefined();
  });

  it("sums over a half-open window", () => {
    if (ccId == null) return;
    expect(ccFinancingCostClpBetween(ccId, "2037-03-31", "2037-04-30")).toBe(9500);
    // Exclusive lower bound, inclusive upper.
    expect(ccFinancingCostClpBetween(ccId, "2037-04-12", "2037-04-30")).toBe(0);
    expect(ccFinancingCostClpBetween(ccId, "2037-04-11", "2037-04-12")).toBe(9500);
    expect(ccFinancingCostClpBetween(ccId, "2037-05-01", "2037-05-31")).toBe(0);
  });
});
