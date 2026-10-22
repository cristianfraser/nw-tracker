import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

/**
 * An AFP fund account with no stored `valuations` rows (an earlier fund of the chain, a fund
 * switched into) gets its chart grid from its cuota history: month-ends from its first units
 * event through today while it holds cuotas (the exact days of its transfer legs are added too,
 * but the monthly grid keeps the latest point of each month, so they show through the month-end).
 */
const SERIES = "afp_vitest_cuota_a";
const PREFIX = "vitest cuota-ledger dates";

function bucketId(like: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug = ? OR slug LIKE ? LIMIT 1`).get(like, `%__${like}`) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`test DB has no ${like} asset group`);
  return row.id;
}

afterEach(() => {
  db.prepare(`DELETE FROM accounts WHERE name LIKE ?`).run(`${PREFIX}%`);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
});

describe("getAccountValuationTimeseries (cuota ledger without stored valuations)", () => {
  it("charts an afp account from its units movements and transfer legs", () => {
    const today = chileCalendarTodayYmd();
    const insAcc = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, import_key, fund_series_key, exclude_from_group_totals)
       VALUES (?, ?, ?, ?, ?, 0)`
    );
    const afpId = Number(
      insAcc.run(bucketId("afp"), `${PREFIX} fund`, "test:cuota-dates|fund", "test:cuota-dates|fund", SERIES).lastInsertRowid
    );
    const senderId = Number(
      insAcc.run(bucketId("afp"), `${PREFIX} sender`, "test:cuota-dates|sender", "test:cuota-dates|sender", SERIES)
        .lastInsertRowid
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM valuations WHERE account_id = ?`).get(afpId)).toEqual({ n: 0 });

    const px = 50_000;
    const insPx = db.prepare(`INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest:px')`);
    insPx.run(SERIES, "2025-01-02", px);

    // A contribution in February, a fund switch received mid-April (a transfer leg carrying cuotas).
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, ?)`
    ).run(afpId, 100 * px, "2025-02-10", "vitest contribution", 100);
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, ?, 'clp', ?, ?, ?)`
    ).run(senderId, afpId, 40 * px, "2025-04-15", "vitest fund switch", 40);

    const ts = getAccountValuationTimeseries(afpId, "clp");
    expect(ts).not.toBeNull();
    const dates = ts!.accounts.points.map((p) => String(p.as_of_date));
    const dk = String(afpId);

    // Month-ends from the first event's month through today (the account still holds cuotas).
    for (const me of monthEndsBetweenInclusive("2025-02-10", today)) {
      if (me > today) continue;
      expect(dates, `month-end ${me}`).toContain(me);
    }
    expect(dates).not.toContain("2025-01-31");
    // The monthly grid keeps one row per month (the latest-dated point), so the switch day is
    // folded into April's month-end; the line steps between the two month-ends around it.
    const at = (d: string) => Number(ts!.accounts.points.find((p) => String(p.as_of_date) === d)![dk]);
    expect(at("2025-02-28")).toBe(100 * px);
    expect(at("2025-03-31")).toBe(100 * px);
    expect(at("2025-04-30")).toBe(140 * px);
    expect(at("2025-05-31")).toBe(140 * px);
  });
});
