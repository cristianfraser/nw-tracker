import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { backfillWebPasteUsdLines } from "./ccWebPasteUsdBackfill.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

describe("backfillWebPasteUsdLines", () => {
  const stmts: number[] = [];
  afterEach(() => {
    for (const sid of stmts.splice(0)) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
    }
  });

  it("recovers the USD amount from raw_line and clears the bogus amount_clp", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = ?`)
      .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
    if (!master) return;

    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'santander', 'import:web-paste|open|2026-08', '20/08/2026', '27/07/2026', '20/08/2026')`
    ).run(master.id);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    stmts.push(sid);

    // Mis-imported the old way: USD dumped into amount_clp, truncated + sign-flipped, no orig_currency.
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, installment_flag, transaction_date, raw_line, dedupe_key)
       VALUES (?, 'ANTHROPIC* CLAU', -99, 0, '30/7/2026', '30/07/2026\tANTHROPIC* CLAU\t-USD99,28', 'vitest-usd-bf')`
    ).run(sid);
    const lineId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;

    const res = backfillWebPasteUsdLines();
    expect(res.fixed).toBeGreaterThanOrEqual(1);

    const fixed = db
      .prepare(`SELECT amount_clp, amount_usd, orig_currency FROM cc_statement_lines WHERE id = ?`)
      .get(lineId) as { amount_clp: number | null; amount_usd: number | null; orig_currency: string | null };
    expect(fixed.amount_clp).toBeNull();
    expect(fixed.amount_usd).toBe(99.28); // Santander charge → positive
    expect(fixed.orig_currency).toBe("usd");
  });
});
