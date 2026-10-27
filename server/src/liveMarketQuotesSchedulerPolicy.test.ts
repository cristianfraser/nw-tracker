import { describe, expect, it } from "vitest";
import type { LiveMarketQuotesSyncResult } from "./liveMarketQuotesSync.js";
import {
  nextLiveQuotesTickAtMs,
  OPEN_TICK_DELAY_MS,
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

describe("nextLiveQuotesTickAtMs", () => {
  const base = 5 * 60_000;
  const session = 2 * 60_000;
  // A session that opens at 13:30:00Z and never closes, enough to place the edges.
  const openAt = Date.parse("2026-10-27T13:30:00Z");
  const sessionOpenAt = (d: Date) => d.getTime() >= openAt;
  const t = (iso: string) => Date.parse(`2026-10-27T${iso}Z`);

  it("sits on wall-clock multiples of the base cadence while the market is closed", () => {
    expect(nextLiveQuotesTickAtMs(t("13:11:12"), base, session, sessionOpenAt)).toBe(t("13:15:00"));
  });

  it("adds a tick just after an open that falls between aligned ticks", () => {
    const sessionAt1331 = (d: Date) => d.getTime() >= t("13:31:00");
    expect(nextLiveQuotesTickAtMs(t("13:30:05"), base, session, sessionAt1331)).toBe(
      t("13:31:00") + OPEN_TICK_DELAY_MS
    );
  });

  it("follows an aligned tick at the open minute with the open tick", () => {
    expect(nextLiveQuotesTickAtMs(t("13:25:09"), base, session, sessionOpenAt)).toBe(t("13:30:00"));
    expect(nextLiveQuotesTickAtMs(t("13:30:09"), base, session, sessionOpenAt)).toBe(
      t("13:30:00") + OPEN_TICK_DELAY_MS
    );
  });

  it("uses the session cadence once the open tick has run", () => {
    expect(nextLiveQuotesTickAtMs(t("13:30:29"), base, session, sessionOpenAt)).toBe(t("13:32:00"));
    expect(nextLiveQuotesTickAtMs(t("14:01:10"), base, session, sessionOpenAt)).toBe(t("14:02:00"));
  });

  it("finds an open edge with the real NYSE calendar across the Chile/New York offset", async () => {
    const { isNyseRegularSessionOpen } = await import("./nyseSession.js");
    // 2026-10-27 09:29:50 New York (EDT) = 13:29:50Z; the open is 13:30:00Z.
    expect(nextLiveQuotesTickAtMs(t("13:29:50"), base, session, isNyseRegularSessionOpen)).toBe(
      t("13:30:00")
    );
    expect(nextLiveQuotesTickAtMs(t("13:30:08"), base, session, isNyseRegularSessionOpen)).toBe(
      t("13:30:00") + OPEN_TICK_DELAY_MS
    );
  });
});
