import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheDepNodeLiveInputs, newCacheDepNode, runInCacheDepNode } from "./cacheDependencies.js";
import {
  aggregationCacheHasForTest,
  clearAggregationCache,
  getAggregationCached,
  invalidateMarketDataAggregations,
} from "./cacheRegistry.js";
import { db } from "./db.js";
import { liveFxPairForYahooSymbol, liveFxPairs } from "./fxLive.js";
import { formatLiveInputs } from "./liveInputsHeader.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { convertCurrency, pairRateOnOrBefore } from "./rates.js";

/**
 * Every core pair has a live rate (docs/any-currency-plan.md C6): EUR/USD live moves a euro figure
 * today, and a EUR/USD tick drops only what read EUR/USD.
 */

function maxDate(sql: string): string {
  return (db.prepare(sql).get() as { d: string }).d;
}

// A weekday after every stored rate, at 14:00 New York: the fx day is open and no pair has a
// stored row dated today.
const lastStored = [
  maxDate(`SELECT MAX(date) AS d FROM fx_daily`),
  maxDate(`SELECT MAX(date) AS d FROM eur_daily`),
  maxDate(`SELECT MAX(date) AS d FROM fx_rates WHERE base = 'eur' AND quote = 'usd'`),
].sort()[2]!;
const instant = new Date(`${lastStored}T18:00:00Z`);
do instant.setUTCDate(instant.getUTCDate() + 1);
while (instant.getUTCDay() === 0 || instant.getUTCDay() === 6);
const today = instant.toISOString().slice(0, 10);
const eurClpStored = (db.prepare(`SELECT clp_per_eur AS v FROM eur_daily ORDER BY date DESC LIMIT 1`).get() as { v: number }).v;

function writeLive(symbol: string, value: number): void {
  insertLiveMarketQuote({
    symbol,
    kind: "fx",
    value,
    currency: null,
    session_ymd: today,
    previous_value: null,
    fetched_at: new Date().toISOString(),
  });
}

// The live row read is the latest by `fetched_at`, so a fx quote another file left with a later
// real timestamp would outrank this file's fixtures. Clear every live fx row before and after each
// test; this file owns the live fx rows it asserts on.
beforeEach(() => {
  db.prepare(`DELETE FROM live_market_quotes WHERE kind = 'fx'`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
  clearAggregationCache();
});

afterEach(() => {
  db.prepare(`DELETE FROM live_market_quotes WHERE kind = 'fx'`).run();
  clearAggregationCache();
  vi.useRealTimers();
});

describe("live exchange-rate pairs", () => {
  it("lists USD/CLP and the core pairs currencies loads, by Yahoo symbol", () => {
    expect(liveFxPairs().map((p) => p.key)).toEqual(["USD_CLP", "EUR_USD"]);
    expect(liveFxPairForYahooSymbol("eurusd=x")).toMatchObject({ key: "EUR_USD", base: "eur", quote: "usd" });
    expect(liveFxPairForYahooSymbol("SPY")).toBeNull();
  });

  it("with no live EUR/USD, today's euro reads the stored rates (EUR/CLP direct)", () => {
    expect(convertCurrency(100, "eur", "clp", today, { side: "mid" })).toBeCloseTo(100 * eurClpStored, 6);
  });

  it("a live EUR/USD moves a euro figure today; EUR/CLP crosses the two live rates", () => {
    writeLive("EUR_USD", 1.2);
    writeLive("USD_CLP", 1000);
    expect(pairRateOnOrBefore("eur", "usd", today)).toEqual({ date: today, mid: 1.2 });
    expect(convertCurrency(100, "eur", "usd", today, { side: "mid" })).toBeCloseTo(120, 9);
    expect(convertCurrency(100, "eur", "clp", today, { side: "mid" })).toBeCloseTo(120_000, 6);
    // A past day keeps the stored rate.
    expect(convertCurrency(100, "eur", "clp", lastStored, { side: "mid" })).toBeCloseTo(100 * eurClpStored, 6);
  });

  it("a EUR/USD tick drops only what read EUR/USD, and the header names the pair", () => {
    writeLive("EUR_USD", 1.2);
    writeLive("USD_CLP", 1000);
    getAggregationCached("daily.series|t:eur", () => convertCurrency(1, "eur", "usd", today, { side: "mid" }));
    getAggregationCached("daily.series|t:usd", () => convertCurrency(1, "usd", "clp", today, { side: "mid" }));

    const eurNode = newCacheDepNode();
    runInCacheDepNode(eurNode, () => convertCurrency(1, "eur", "usd", today, { side: "mid" }));
    expect(formatLiveInputs(cacheDepNodeLiveInputs(eurNode))).toBe("$fx:EUR_USD");
    const crossNode = newCacheDepNode();
    runInCacheDepNode(crossNode, () => convertCurrency(1, "eur", "clp", today, { side: "mid" }));
    expect(formatLiveInputs(cacheDepNodeLiveInputs(crossNode))).toBe("$fx,$fx:EUR_USD");

    invalidateMarketDataAggregations("live_tail", { tickers: new Set(), fx: new Set(["EUR_USD"]) });
    expect(aggregationCacheHasForTest("daily.series|t:eur")).toBe(false);
    expect(aggregationCacheHasForTest("daily.series|t:usd")).toBe(true);
  });
});
