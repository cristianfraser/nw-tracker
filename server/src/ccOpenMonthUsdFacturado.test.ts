import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { openMonthUsdFacturado } from "./ccBillingBalances.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

/**
 * Manually-entered USD purchases in the open cycle must surface as their own US$ facturado
 * component (so the chart shows the CLP + US$ stacked bars), not get lumped into facturado_clp.
 */
describe("openMonthUsdFacturado", () => {
  const stmts: number[] = [];
  afterEach(() => {
    for (const sid of stmts.splice(0)) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
    }
  });

  it("sums open-cycle foreign (amount_usd, no CLP) lines in USD and CLP, leaving CLP lines out", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = ?`)
      .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
    if (!master) return;

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
       VALUES (?, 'santander', 'import:web-paste|open|2026-09', '20/09/2026', '21/08/2026', '20/09/2026', 'clp')`
    ).run(master.id);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    stmts.push(sid);
    const billingMonth = listCcStatementsForAccount(master.id).find((s) => s.id === sid)?.billing_month;
    if (!billingMonth) return;

    const addLine = (merchant: string, clp: number | null, usd: number | null) =>
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, amount_usd, orig_currency, installment_flag, transaction_date, dedupe_key)
           VALUES (?, ?, ?, ?, ?, 0, '25/08/2026', ?)`
        )
        .run(sid, merchant, clp, usd, usd != null ? "usd" : null, `vitest-openusd-${merchant}`);

    addLine("ANTHROPIC USD", null, 100); // foreign USD charge
    addLine("APPLE USD", null, 50); // foreign USD charge
    addLine("JUMBO CLP", 30_000, null); // domestic CLP charge → excluded

    const res = openMonthUsdFacturado(master.id, billingMonth);
    // Only the two foreign lines (100 + 50), never the CLP 30.000, count toward the USD split.
    expect(res.usd).toBe(150);
    expect(res.clp).toBeGreaterThan(0); // 150 USD × FX
  });
});
