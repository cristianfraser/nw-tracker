import { describe, expect, it } from "vitest";
import { chainDailyPct, chainPeriodStartYmd } from "./blankPctDailyChain.js";
import {
  fillBlankGroupPct,
  type CardMetricsAccountRow,
  type CardPeriodMetricsDto,
  type ChainedGroupPct,
  type NavCardMetricsVariantDto,
} from "./dashboardNavCardMetrics.js";

describe("chainPeriodStartYmd", () => {
  it("starts each period after its prior close: yesterday, last month-end, last year-end, none", () => {
    expect(chainPeriodStartYmd("day", "2026-10-27")).toBe("2026-10-26");
    expect(chainPeriodStartYmd("month", "2026-10-27")).toBe("2026-09-30");
    expect(chainPeriodStartYmd("year", "2026-10-27")).toBe("2025-12-31");
    expect(chainPeriodStartYmd("total", "2026-10-27")).toBeNull();
  });
});

describe("chainDailyPct", () => {
  // Bought on 05-28, sold on 06-16: the days with nothing held carry no return.
  const points = [
    { as_of_date: "2025-12-31", pct: 0.5 },
    { as_of_date: "2026-05-27", pct: null },
    { as_of_date: "2026-05-29", pct: 0.1 },
    { as_of_date: "2026-06-10", pct: -0.2 },
    { as_of_date: "2026-06-16", pct: 0.05 },
    { as_of_date: "2026-06-17", pct: null },
  ];

  it("chains the days inside the window, skipping days without a return", () => {
    expect(chainDailyPct(points, "2025-12-31", "2026-10-27")).toBeCloseTo(1.1 * 0.8 * 1.05 - 1, 12);
    expect(chainDailyPct(points, null, "2026-10-27")).toBeCloseTo(1.5 * 1.1 * 0.8 * 1.05 - 1, 12);
  });

  it("is null when no day in the window has a return", () => {
    expect(chainDailyPct(points, "2026-06-16", "2026-10-27")).toBeNull();
  });
});

describe("fillBlankGroupPct", () => {
  const period = (delta: number | null): CardPeriodMetricsDto => ({
    deposits_clp: 0,
    deposits_usd: null,
    delta_total_clp: -100_000,
    delta_total_usd: null,
    deposits_period_clp: 0,
    deposits_period_usd: null,
    delta_period_clp: delta,
    delta_period_usd: null,
  });
  const metrics: NavCardMetricsVariantDto = {
    day: period(0),
    month: period(-13_500),
    year: period(-100_000),
  };
  const none = { clp: null, usd: null };
  // Bought and sold this year: empty now and at the year start, so the year and Total fill.
  const liquidatedRow = {
    account_id: 60,
    current_value_clp: 0,
    current_value_usd: 0,
    prior_day_close_clp: 0,
    prior_month_close_clp: 120_000,
    prior_year_close_clp: 0,
  } as CardMetricsAccountRow;

  it("fills only blank cells with a material P/L, leaving answered cells alone", () => {
    const calls: string[] = [];
    const chained: ChainedGroupPct = (_scope, p, unit) => {
      calls.push(`${p}:${unit}`);
      return -0.04;
    };
    const out = fillBlankGroupPct(
      { day: none, month: { clp: -0.005, usd: null }, year: none, total: none },
      metrics,
      [liquidatedRow],
      { kind: "group", slug: "x" },
      chained
    );
    expect(out.month.clp).toBe(-0.005);
    expect(out.year.clp).toBe(-0.04);
    expect(out.total.clp).toBe(-0.04);
    expect(out.day.clp).toBeNull();
    // No USD P/L, no zero-P/L day, no answered month: nothing else is asked for.
    expect(calls.sort()).toEqual(["total:clp", "year:clp"]);
  });

  it("is the identity without a resolver", () => {
    const pct = { day: none, month: none, year: none, total: none };
    expect(fillBlankGroupPct(pct, metrics, [liquidatedRow], { kind: "group", slug: "x" }, undefined)).toBe(pct);
  });

  it("leaves a blank alone when the scope holds value at either end", () => {
    const held = { ...liquidatedRow, current_value_clp: 50_000 };
    const chained: ChainedGroupPct = () => {
      throw new Error("must not be asked");
    };
    const pct = { day: none, month: none, year: none, total: none };
    expect(fillBlankGroupPct(pct, metrics, [held], { kind: "group", slug: "x" }, chained)).toEqual(pct);
  });
});
