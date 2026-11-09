import { chileCalendarTodayYmd } from "./chileDate.js";
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { latestValuationRowOnOrBefore, latestValuationRowOnOrBeforeChileToday } from "./valuationLatest.js";

describe("valuationLatest", () => {
  it("returns the latest valuation on or before the as-of date", () => {
    const row = db
      .prepare(
        `SELECT account_id, as_of_date, value AS value_clp FROM valuations
         WHERE value IS NOT NULL
         ORDER BY as_of_date DESC LIMIT 1`
      )
      .get() as { account_id: number; as_of_date: string; value_clp: number } | undefined;
    if (!row) return;

    const hit = latestValuationRowOnOrBefore(row.account_id, row.as_of_date);
    expect(hit?.as_of_date).toBe(row.as_of_date);
    expect(hit?.value_clp).toBe(row.value_clp);

    const before = latestValuationRowOnOrBefore(row.account_id, "1900-01-01");
    expect(before).toBeUndefined();
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
