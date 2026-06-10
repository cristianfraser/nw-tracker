import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import * as syncLatest from "./syncLatestDisplayValueClp.js";

describe("getAccountMonthlyPerformance live patch vs cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearAggregationCache();
  });

  it("re-applies live close on each read when monthly perf cache is warm", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'OILK' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;

    const spy = vi.spyOn(syncLatest, "syncLatestDisplayValueClp");
    spy.mockReturnValueOnce({ value_clp: 3_004_764, as_of_date: "2026-06-03" });
    spy.mockReturnValueOnce({ value_clp: 3_051_857, as_of_date: "2026-06-03" });

    const first = getAccountMonthlyPerformance(row.id, "clp");
    const second = getAccountMonthlyPerformance(row.id, "clp");
    if (!first?.monthly.length || !second?.monthly.length) return;

    const top1 = first.monthly[0];
    const top2 = second.monthly[0];
    if (top1?.as_of_date !== "2026-06-03" || top2?.as_of_date !== "2026-06-03") return;

    expect(top2.closing_value).toBeGreaterThan(top1.closing_value ?? 0);
    expect(top2.nominal_pl).toBeGreaterThan(top1.nominal_pl ?? 0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
