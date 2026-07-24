import { describe, expect, it } from "vitest";
import { buildFlowsPlPayload } from "./flowsPl.js";

/**
 * Phase B3: the `?days` opt-in adds a per-day P/L block to the flows → PL payload, built from
 * the shared `pg:<group_slug>` daily series. The M/Y payload is unchanged when `days` is absent.
 */
describe("flows PL daily block (buildFlowsPlPayload with days)", () => {
  it("omits the daily block when days is not passed (M/Y callers unchanged)", () => {
    const payload = buildFlowsPlPayload();
    expect(payload.chart_daily).toBeUndefined();
    expect(payload.chart_daily_usd).toBeUndefined();
    expect(payload.chart_monthly.length).toBeGreaterThan(0);
  });

  it("adds a contiguous daily block (CLP + USD) when days is passed", () => {
    const payload = buildFlowsPlPayload({ days: 90 });
    expect(payload.chart_daily).toBeDefined();
    expect(payload.chart_daily_usd).toBeDefined();
    const daily = payload.chart_daily!;
    expect(daily.length).toBeGreaterThan(0);

    // One point per calendar day, strictly ascending and finite.
    for (let i = 0; i < daily.length; i++) {
      const p = daily[i]!;
      expect(/^\d{4}-\d{2}-\d{2}$/.test(p.as_of_date)).toBe(true);
      expect(Number.isFinite(p.total)).toBe(true);
      expect(Number.isFinite(p.brokerage + p.retirement + p.cash)).toBe(true);
      // total is the sum of the three bucket legs
      expect(p.total).toBeCloseTo(p.brokerage + p.retirement + p.cash, 6);
      if (i > 0) expect(p.as_of_date > daily[i - 1]!.as_of_date).toBe(true);
    }

    // cumulative_total is a running sum of total over the window.
    const last = daily[daily.length - 1]!;
    const manualCumulative = daily.reduce((s, p) => s + p.total, 0);
    expect(last.cumulative_total).toBeCloseTo(manualCumulative, 4);
  });
});
