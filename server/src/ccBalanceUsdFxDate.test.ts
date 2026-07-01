import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { balanceUsdFxDateIso } from "./ccBillingBalances.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

/**
 * Displayed-balance USD charges are valued at the facturación pay-by date minus one day, so the CLP
 * value locks at settlement instead of drifting with the statement-close FX.
 */
describe("balanceUsdFxDateIso", () => {
  const stmts: number[] = [];
  afterEach(() => {
    for (const sid of stmts.splice(0)) db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
  });

  it("uses the stored pay_by minus one day when the statement has one", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = ?`)
      .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
    if (!master) return;
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by)
       VALUES (?, 'santander', 'vitest-fx.pdf', '23/06/2026', '25/05/2026', '23/06/2026', '09/07/2026')`
    ).run(master.id);
    stmts.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    expect(balanceUsdFxDateIso(master.id, "23/06/2026")).toBe("2026-07-08");
  });

  it("falls back to the 10th of the next month (minus one day) for open web-paste statements with no pay_by", () => {
    // No matching statement row → computed pay-by = 10 Aug → minus one day = 9 Aug.
    expect(balanceUsdFxDateIso(-999_999, "20/07/2026")).toBe("2026-08-09");
  });
});
