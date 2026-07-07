import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  clearLiveMarketQuotesForTest,
  getLatestLiveEquityQuoteRow,
  getLatestLiveFxQuoteRow,
} from "./liveMarketQuotesDb.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { syncAllLiveMarketQuotes } from "./liveMarketQuotesSync.js";
import { snapshotTables } from "./test/snapshotTables.js";

vi.mock("./equityYahooEod.js", () => ({
  fetchYahooLiveQuote: vi.fn(async (symbol: string) => ({
    price: symbol === "CLP=X" ? 950 : symbol === "SPY" ? 600 : 42,
    previous_close: symbol === "CLP=X" ? 945 : symbol === "SPY" ? 590 : 40,
    session_ymd: "2026-06-01",
  })),
}));

vi.mock("./fxYahooEodSync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fxYahooEodSync.js")>();
  return {
    ...actual,
    syncYahooFxUsdFromYahoo: vi.fn(async () => ({ rows: 0 })),
  };
});

vi.mock("./fxLive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fxLive.js")>();
  return {
    ...actual,
    fetchYahooLiveUsdClpPerUsd: vi.fn(async (now?: Date) => ({
      clp_per_usd: 950,
      session_ymd: "2026-05-19",
      previous_clp_per_usd: 945,
    })),
  };
});

vi.mock("./bcentralApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bcentralApi.js")>();
  return {
    ...actual,
    isBcentralConfigured: () => false,
  };
});

// This file mutates fx_daily + live_market_quotes for controlled fixtures; snapshot both and
// restore in afterAll so it doesn't poison other files sharing the DB.
const restoreTables = snapshotTables(["fx_daily", "live_market_quotes"]);
afterAll(() => restoreTables());

// Each test asserts on the *latest* EOD / live quote, so it needs an empty slate: fx_daily
// empty (its inserted date is the latest) and live_market_quotes empty (the dev-DB copy ships
// real USD_CLP/equity quotes whose future-dated fetched_at would otherwise outrank the fixture).
beforeEach(() => {
  db.exec("DELETE FROM fx_daily");
  clearLiveMarketQuotesForTest();
});

afterEach(() => {
  clearLiveMarketQuotesForTest();
  db.exec("DELETE FROM fx_daily");
});

describe("syncAllLiveMarketQuotes", () => {
  it("mirrors fx_daily EOD after NYSE close", async () => {
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run("2026-06-05", 910.29);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T22:00:00.000Z"));
    try {
      await syncAllLiveMarketQuotes(new Date("2026-06-06T22:00:00.000Z"));
      const fx = getLatestLiveFxQuoteRow(600_000);
      expect(fx?.value).toBeCloseTo(910.29, 2);
      expect(fx?.session_ymd).toBe("2026-06-05");
    } finally {
      vi.useRealTimers();
    }
  });
  it("inserts Yahoo CLP=X during NYSE session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T15:00:00.000Z"));
    try {
      await syncAllLiveMarketQuotes(new Date("2026-05-19T15:00:00.000Z"));
      const fx = getLatestLiveFxQuoteRow(600_000);
      expect(fx?.value).toBe(950);
      expect(fx?.symbol).toBe(LIVE_FX_SYMBOL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("inserts live rows for distinct account tickers", async () => {
    const result = await syncAllLiveMarketQuotes(new Date("2026-06-01T16:00:00Z"));
    const spy = result.equities.find((r) => r.ticker === "SPY");
    if (!spy) return;
    expect(spy.ok).toBe(true);
    const row = getLatestLiveEquityQuoteRow("SPY", 600_000);
    if (!row) return;
    expect(row.value).toBe(600);
    expect(row.session_ymd).toBe("2026-06-01");
  });

  it("flags changed values on first poll, not on an identical re-poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T15:00:00.000Z"));
    try {
      const first = await syncAllLiveMarketQuotes(new Date("2026-05-19T15:00:00.000Z"));
      expect(first.values_changed).toBe(true);

      // Mocked Yahoo returns the same prices; nothing effective changed → no invalidation.
      vi.setSystemTime(new Date("2026-05-19T15:05:00.000Z"));
      const second = await syncAllLiveMarketQuotes(new Date("2026-05-19T15:05:00.000Z"));
      expect(second.values_changed).toBe(false);
      expect(second.equities.filter((r) => r.ok).every((r) => r.changed === false)).toBe(true);
      expect(second.fx.changed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
