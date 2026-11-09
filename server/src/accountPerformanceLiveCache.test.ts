import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { valuationSeriesMonthlyPerformance } from "./accountPerformance.js";
import * as todayValue from "./accountTodayValue.js";

describe("valuationSeriesMonthlyPerformance live patch vs cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearAggregationCache();
  });

  it("re-applies live close on each read when monthly perf cache is warm", () => {
    const row = db.prepare(`SELECT id FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`).get() as { id: number };
    const today = chileCalendarTodayYmd();
    const live = (value: number) => ({
      value_clp: value,
      as_of_date: today,
      priced_on: today,
      native_value: value,
      native_currency: "clp" as const,
      side: "asset" as const,
    });

    const real = todayValue.accountTodayValue;
    let liveValue = 3_000_000;
    vi.spyOn(todayValue, "accountTodayValue").mockImplementation((id, ...rest) =>
      id === row.id ? live(liveValue) : real(id, ...rest)
    );

    const first = valuationSeriesMonthlyPerformance(row.id, "clp")!.monthly[0]!;
    liveValue = 3_050_000;
    const second = valuationSeriesMonthlyPerformance(row.id, "clp")!.monthly[0]!;

    expect(first.as_of_date).toBe(today);
    expect(second.as_of_date).toBe(today);
    expect(first.closing_value).toBe(3_000_000);
    expect(second.closing_value).toBe(3_050_000);
    expect((second.nominal_pl ?? 0) - (first.nominal_pl ?? 0)).toBeCloseTo(50_000, 6);
  });
});
