import { chileCalendarTodayYmd } from "./chileDate.js";
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { latestValuationRowOnOrBefore, latestValuationRowOnOrBeforeChileToday } from "./valuationLatest.js";

describe("valuationLatest", () => {
  it("returns the latest valuation on or before the as-of date", () => {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number };
    const importKey = "vitest:valuation-latest|on-or-before";
    const accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(leaf.id, "Vitest · valuation latest", importKey, importKey).lastInsertRowid
    );
    try {
      const val = db.prepare(
        `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
      );
      val.run(accountId, "2015-01-31", 100_000);
      val.run(accountId, "2015-02-28", 200_000);
      val.run(accountId, "2015-03-31", 300_000);

      expect(latestValuationRowOnOrBefore(accountId, "2015-02-28")).toEqual({
        as_of_date: "2015-02-28",
        value_clp: 200_000,
      });
      // Between two rows: the earlier one, never the later.
      expect(latestValuationRowOnOrBefore(accountId, "2015-03-30")).toEqual({
        as_of_date: "2015-02-28",
        value_clp: 200_000,
      });
      expect(latestValuationRowOnOrBefore(accountId, "2099-01-01")).toEqual({
        as_of_date: "2015-03-31",
        value_clp: 300_000,
      });
      expect(latestValuationRowOnOrBefore(accountId, "2015-01-30")).toBeUndefined();
    } finally {
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });

  it("Chile-today lookup never returns a future-dated row when an on-or-before row exists", () => {
    // The person's cards carry the current month-end anchor, dated after today.
    const today = chileCalendarTodayYmd();
    const row = db
      .prepare(
        `SELECT v.account_id FROM valuations v
         WHERE v.as_of_date > ?
           AND EXISTS (SELECT 1 FROM valuations p WHERE p.account_id = v.account_id AND p.as_of_date <= ?)
         ORDER BY v.account_id LIMIT 1`
      )
      .get(today, today) as { account_id: number };

    const latest = latestValuationRowOnOrBeforeChileToday(row.account_id);
    expect(latest).not.toBeNull();
    expect(latest!.as_of_date <= today).toBe(true);
  });
});
