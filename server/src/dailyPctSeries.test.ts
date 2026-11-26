import { describe, expect, it } from "vitest";
import { accountDailyPctPoints, groupDailyPctPoints, packDailyPct, unpackDailyPct } from "./dailyPctSeries.js";
import { db } from "./db.js";
import { resolveAccountDailySeries, resolveGroupDailySeries } from "./groupDailySeries.js";

/**
 * The compact daily-returns cache answers exactly the pct of the full daily series it stands in
 * for (the one the page's day view at Rango Todo builds), day by day, for a group and an account.
 */
describe("dailyPctSeries", () => {
  it("a group's daily returns are the full series' pct, day by day", () => {
    const full = resolveGroupDailySeries("net_worth", "clp", 0);
    expect(full).not.toBeNull();
    const compact = groupDailyPctPoints("net_worth", "clp");
    expect(compact).not.toBeNull();
    expect(compact!.length).toBe(full!.points.length);
    expect(compact!.length).toBeGreaterThan(30);
    expect(compact).toEqual(full!.points.map((p) => ({ as_of_date: p.as_of_date, pct: p.pct })));
  });

  it("an account's daily returns are its full series' pct, in both units", () => {
    const acc = db
      .prepare(
        `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
         FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.equity_ticker IS NOT NULL ORDER BY a.id LIMIT 1`
      )
      .get() as { account_id: number; name: string | null; bucket_slug: string; import_key: string | null };
    expect(acc).toBeDefined();
    for (const unit of ["clp", "usd"] as const) {
      const full = resolveAccountDailySeries(acc, unit, 0);
      expect(accountDailyPctPoints(acc, unit)).toEqual(full.points.map((p) => ({ as_of_date: p.as_of_date, pct: p.pct })));
    }
  });

  it("a group with no accounts has no returns", () => {
    expect(groupDailyPctPoints("no_such_group_for_this_test", "clp")).toBeNull();
  });
});

describe("packed daily returns", () => {
  const points = [
    { as_of_date: "2026-02-27", pct: 0.5 },
    { as_of_date: "2026-02-28", pct: null },
    { as_of_date: "2026-03-01", pct: -1.25 },
  ];

  it("come back as the same points, a missing return included, across a month end", () => {
    const packed = packDailyPct(points);
    expect(packed.start).toBe("2026-02-27");
    expect(packed.pct).toBeInstanceOf(Float64Array);
    expect(unpackDailyPct(packed)).toEqual(points);
    expect(unpackDailyPct(packDailyPct([]))).toEqual([]);
  });

  it("refuse a series with a missing day or a pct that is not a number", () => {
    expect(() => packDailyPct([points[0]!, points[2]!])).toThrow(/contiguous/);
    expect(() => packDailyPct([{ as_of_date: "2026-02-27", pct: Number.NaN }])).toThrow(/pct of NaN/);
  });
});
