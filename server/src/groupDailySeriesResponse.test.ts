import { describe, expect, it } from "vitest";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";
import { groupDailySeriesResponse } from "./groupDailySeriesResponse.js";

const DAYS = 120;

/**
 * The day table's closing is the group's total as every other surface shows it: net of the
 * linked cards for the groups whose total is (cash savings, Efectivo, net worth), the members'
 * sum elsewhere. The cards are an offset on the closing only.
 */
describe("groupDailySeriesResponse — closings net of the linked cards", () => {
  const overview = new Map(getDashboardOverviewDaily("clp", DAYS).points.map((p) => [p.as_of_date, p]));

  it.each([
    ["net_worth", "net_worth"],
    ["cash_eqs", "cash_eqs"],
  ] as const)("%s closes each day at the overview's figure", (slug, overviewKey) => {
    const res = groupDailySeriesResponse(slug, "clp", DAYS, false)!;
    const raw = resolveGroupDailySeries(slug, "clp", DAYS)!;
    expect(res.points.length).toBe(raw.points.length);
    let nettedDays = 0;
    res.points.forEach((p, i) => {
      const expected = overview.get(p.as_of_date)![overviewKey];
      expect(p.value).not.toBeNull();
      expect(Math.abs(p.value! - expected!)).toBeLessThan(0.01);
      if (Math.abs(p.value! - raw.points[i]!.value!) > 1) nettedDays += 1;
      // Flow, P/L and % are the members' own.
      expect(p.flow).toBe(raw.points[i]!.flow);
      expect(p.pl).toBe(raw.points[i]!.pl);
      expect(p.pct).toBe(raw.points[i]!.pct);
      const prev = i === 0 ? res.baseline.value : res.points[i - 1]!.value;
      expect(p.delta).toBeCloseTo(p.value! - prev!, 6);
    });
    // The test person owes on a linked card, so the netting is exercised.
    expect(nettedDays).toBeGreaterThan(0);
    expect(res.accounts).toEqual(raw.accounts);
  });

  it("leaves a group without a netting node as its members' sum", () => {
    const res = groupDailySeriesResponse("brokerage", "clp", DAYS, false)!;
    const raw = resolveGroupDailySeries("brokerage", "clp", DAYS)!;
    expect(res.points).toEqual(raw.points);
    expect(res.baseline).toEqual(raw.baseline);
  });
});
