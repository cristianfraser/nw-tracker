import { afterEach, describe, expect, it } from "vitest";
import {
  clearLiveMarketQuotesForTest,
  getLatestLiveEquityQuoteRow,
  insertLiveMarketQuote,
  pruneLiveMarketQuotes,
} from "./liveMarketQuotesDb.js";

const TEST_TICKER = "LIVE_DB_TEST";

afterEach(() => {
  clearLiveMarketQuotesForTest();
});

describe("liveMarketQuotesDb", () => {
  it("returns latest fresh equity row by fetched_at", () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const fresh = new Date().toISOString();
    insertLiveMarketQuote({
      symbol: TEST_TICKER,
      kind: "equity_usd",
      value: 100,
      session_ymd: "2026-06-01",
      previous_value: 90,
      fetched_at: old,
    });
    insertLiveMarketQuote({
      symbol: TEST_TICKER,
      kind: "equity_usd",
      value: 110,
      session_ymd: "2026-06-01",
      previous_value: 100,
      fetched_at: fresh,
    });
    const row = getLatestLiveEquityQuoteRow(TEST_TICKER, 120_000);
    expect(row?.value).toBe(110);
    expect(row?.fetched_at).toBe(fresh);
  });

  it("prunes rows older than retention window", () => {
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    insertLiveMarketQuote({
      symbol: TEST_TICKER,
      kind: "equity_usd",
      value: 1,
      session_ymd: "2026-01-01",
      previous_value: null,
      fetched_at: stale,
    });
    const n = pruneLiveMarketQuotes(48);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(getLatestLiveEquityQuoteRow(TEST_TICKER)).toBeNull();
  });
});
