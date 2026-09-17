import { describe, expect, it } from "vitest";
import type { LiveMarketQuotesSyncResult } from "./liveMarketQuotesSync.js";
import {
  RETRY_DELAYS_MS,
  planAfterTick,
  resumedAfterSuspend,
  tickFailedWholesale,
} from "./liveMarketQuotesSchedulerPolicy.js";

function result(equityOks: boolean[]): LiveMarketQuotesSyncResult {
  return {
    equities: equityOks.map((ok, i) => ({ ticker: `T${i}`, ok, ...(ok ? {} : { error: "fetch failed" }) })),
    fx: { ok: true, rows: 1, changed: false },
    pruned: 0,
    values_changed: false,
  };
}

describe("resumedAfterSuspend", () => {
  const interval = 5 * 60 * 1000;
  it("is a resume when the tick fires more than two intervals late", () => {
    expect(resumedAfterSuspend(0, 2 * interval + 1, interval)).toBe(true);
    expect(resumedAfterSuspend(0, 3 * 60 * 60 * 1000, interval)).toBe(true);
  });
  it("is not a resume for ordinary jitter or the first tick", () => {
    expect(resumedAfterSuspend(0, interval + 5_000, interval)).toBe(false);
    expect(resumedAfterSuspend(0, 2 * interval, interval)).toBe(false);
    expect(resumedAfterSuspend(null, 10 * interval, interval)).toBe(false);
  });
});

describe("tickFailedWholesale", () => {
  it("is wholesale only when every equity failed", () => {
    expect(tickFailedWholesale(result([false, false, false]))).toBe(true);
    expect(tickFailedWholesale(result([false, true, false]))).toBe(false);
    expect(tickFailedWholesale(result([true, true]))).toBe(false);
    expect(tickFailedWholesale(result([]))).toBe(false);
  });
});

describe("planAfterTick", () => {
  it("spends the retries in order, then stops until a success refills them", () => {
    const first = planAfterTick(RETRY_DELAYS_MS.length, true);
    expect(first).toEqual({ delayMs: 15_000, budgetRemaining: 1 });
    const second = planAfterTick(first.budgetRemaining, true);
    expect(second).toEqual({ delayMs: 45_000, budgetRemaining: 0 });
    const third = planAfterTick(second.budgetRemaining, true);
    expect(third).toEqual({ delayMs: null, budgetRemaining: 0 });
    // A later interval tick that still fails gets no retry — the budget is exhausted.
    expect(planAfterTick(0, true).delayMs).toBeNull();
  });
  it("a success refills the budget and schedules nothing", () => {
    expect(planAfterTick(0, false)).toEqual({ delayMs: null, budgetRemaining: RETRY_DELAYS_MS.length });
    expect(planAfterTick(1, false)).toEqual({ delayMs: null, budgetRemaining: RETRY_DELAYS_MS.length });
  });
});
