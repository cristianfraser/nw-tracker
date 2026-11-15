import { describe, expect, it } from "vitest";
import { shouldUseLivePairQuote } from "./fxLive.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";

const shouldUseLiveFxQuote = (now: Date) => shouldUseLivePairQuote(LIVE_FX_SYMBOL, now);

describe("shouldUseLivePairQuote (the live dollar)", () => {
  it("is true while the fx day is open — NYSE hours, US holidays and Chilean holidays alike", () => {
    expect(shouldUseLiveFxQuote(new Date("2026-05-19T11:00:00-04:00"))).toBe(true);
    expect(shouldUseLiveFxQuote(new Date("2026-05-25T11:00:00-04:00"))).toBe(true); // Memorial Day
    expect(shouldUseLiveFxQuote(new Date("2026-05-21T11:00:00-04:00"))).toBe(true); // Glorias Navales
  });

  it("is false after 17:05 New York and on weekends", () => {
    expect(shouldUseLiveFxQuote(new Date("2026-05-19T17:10:00-04:00"))).toBe(false);
    expect(shouldUseLiveFxQuote(new Date("2026-05-23T11:00:00-04:00"))).toBe(false); // Saturday
  });
});

describe("pairRateOnOrBefore and the live-dollar dependency", () => {
  it("a date no fresh live row can match reads the stored close and reports no live read", async () => {
    const { db } = await import("./db.js");
    const { insertLiveMarketQuote, getLatestLiveFxQuoteRow } = await import("./liveMarketQuotesDb.js");
    const { LIVE_FX_SYMBOL } = await import("./liveMarketQuotesConfig.js");
    const { pairRateOnOrBefore, storedPairRate } = await import("./rates.js");
    const { cacheDepNodeReadsLiveInput, newCacheDepNode, runInCacheDepNode } = await import("./cacheDependencies.js");
    const { vi } = await import("vitest");

    const last = (db.prepare(`SELECT MAX(date) AS d FROM fx_daily`).get() as { d: string }).d;
    // A weekday after the last stored close, at 14:00 New York: the fx day is open.
    const day = new Date(`${last}T18:00:00Z`);
    do day.setUTCDate(day.getUTCDate() + 1);
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
    const today = day.toISOString().slice(0, 10);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day);
    const fetchedAt = new Date().toISOString();
    try {
      insertLiveMarketQuote({
        symbol: LIVE_FX_SYMBOL,
        kind: "fx",
        value: 1234.5,
        currency: null,
        session_ymd: today,
        previous_value: null,
        fetched_at: fetchedAt,
      });
      expect(getLatestLiveFxQuoteRow()?.value).toBe(1234.5);

      const past = newCacheDepNode();
      const pastFx = runInCacheDepNode(past, () => pairRateOnOrBefore("usd", "clp", last));
      expect(pastFx).toEqual(storedPairRate("usd", "clp", last));
      expect(cacheDepNodeReadsLiveInput(past)).toBe(false);

      const live = newCacheDepNode();
      expect(runInCacheDepNode(live, () => pairRateOnOrBefore("usd", "clp", today))).toEqual({ date: today, mid: 1234.5 });
      expect(cacheDepNodeReadsLiveInput(live)).toBe(true);
    } finally {
      db.prepare(`DELETE FROM live_market_quotes WHERE symbol = ? AND fetched_at = ?`).run(LIVE_FX_SYMBOL, fetchedAt);
      vi.useRealTimers();
    }
  });
});
