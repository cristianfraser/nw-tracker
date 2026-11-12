import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  clearLiveMarketQuotesForTest,
  getLatestLiveEquityQuoteRow,
  getLatestLiveFxQuoteRow,
  getLatestLivePairQuoteRow,
} from "./liveMarketQuotesDb.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { syncAllLiveMarketQuotes, writeStreamQuotes } from "./liveMarketQuotesSync.js";
import { fetchYahooLiveQuote } from "./equityYahooEod.js";
import { snapshotTables } from "./test/snapshotTables.js";

vi.mock("./equityYahooEod.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./equityYahooEod.js")>()),
  fetchYahooLiveQuote: vi.fn(async (symbol: string) => ({
    price: symbol === "CLP=X" ? 950 : symbol === "EURUSD=X" ? 1.1 : symbol === "SPY" ? 600 : 270,
    previous_close: symbol === "CLP=X" ? 945 : symbol === "EURUSD=X" ? 1.09 : symbol === "SPY" ? 590 : 268,
    session_ymd: "2026-06-01",
    splits: [],
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
    fetchYahooLivePairRate: vi.fn(async (_pair: unknown, now?: Date) => ({
      rate: 1.1,
      session_ymd: "2026-05-19",
      previous_rate: 1.09,
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
// No request leaves the test: every Yahoo call is mocked above.
globalThis.fetch = (async (u: unknown) => {
  throw new Error(`network in test: ${String(u)}`);
}) as typeof fetch;
const restoreTables = snapshotTables(["fx_daily", "fx_rates", "live_market_quotes"]);
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
  it("mirrors the stored fx_daily close outside the fx day (Saturday)", async () => {
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
  it("inserts Yahoo CLP=X while the fx day is open", async () => {
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

  it("stores EUR/USD live while the fx day is open, and its close once at the day end", async () => {
    const day = "2026-05-19";
    db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date >= ?`).run(day);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(`${day}T15:00:00.000Z`));
      const open = await syncAllLiveMarketQuotes(new Date(`${day}T15:00:00.000Z`));
      expect(open.fx_pairs).toEqual([{ pair: "EUR_USD", ok: true, rows: 1, changed: true, wrote_close: false }]);
      const row = getLatestLivePairQuoteRow("EUR_USD", 600_000);
      expect(row?.value).toBe(1.1);
      expect(row?.previous_value).toBe(1.09);
      expect(row?.session_ymd).toBe(day);
      // 17:10 New York: the fx day has ended — the last live rate becomes the stored close.
      vi.setSystemTime(new Date(`${day}T21:10:00.000Z`));
      const closed = await syncAllLiveMarketQuotes(new Date(`${day}T21:10:00.000Z`));
      expect(closed.fx_pairs[0]).toMatchObject({ pair: "EUR_USD", rows: 1, wrote_close: true });
      const stored = db
        .prepare(`SELECT mid, source FROM fx_rates WHERE base = 'eur' AND quote = 'usd' AND date = ?`)
        .get(day) as { mid: number; source: string };
      expect(stored).toEqual({ mid: 1.1, source: "live:EURUSD=X" });
      const again = await syncAllLiveMarketQuotes(new Date(`${day}T21:15:00.000Z`));
      expect(again.fx_pairs[0]).toMatchObject({ rows: 0, wrote_close: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the symbols and the dollar the stream covers to the stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T15:00:00.000Z"));
    try {
      vi.mocked(fetchYahooLiveQuote).mockClear();
      const result = await syncAllLiveMarketQuotes(new Date("2026-05-19T15:00:00.000Z"), {
        skipTickers: new Set(["SPY"]),
        skipLiveFxPairs: new Set(["USD_CLP", "EUR_USD"]),
      });
      const fetched = vi.mocked(fetchYahooLiveQuote).mock.calls.map((c) => c[0]);
      expect(fetched).not.toContain("SPY");
      expect(result.equities.some((r) => r.ticker === "SPY")).toBe(false);
      expect(result.fx.rows).toBe(0);
      expect(fetched).not.toContain("EURUSD=X");
      expect(result.fx_pairs).toEqual([{ pair: "EUR_USD", ok: true, rows: 0, changed: false, wrote_close: false }]);
      expect(getLatestLiveFxQuoteRow(600_000)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("writeStreamQuotes", () => {
  it("writes streamed prices as live rows, the dollar as the live rate", () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-01T16:00:00Z");
    vi.setSystemTime(now);
    try {
      const result = writeStreamQuotes(
        [
          { symbol: "SPY", price: 601.25, timeMs: now.getTime(), previousClose: 590 },
          { symbol: "CLP=X", price: 951.5, timeMs: now.getTime(), previousClose: 945 },
        ],
        now
      );
      expect(result).toEqual({ changedTickers: ["SPY"], fxChanged: ["USD_CLP"] });
      const row = getLatestLiveEquityQuoteRow("SPY", 600_000);
      expect(row?.value).toBe(601.25);
      expect(row?.previous_value).toBe(590);
      expect(row?.session_ymd).toBe("2026-06-01");
      expect(getLatestLiveFxQuoteRow(600_000)?.value).toBe(951.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a streamed EUR/USD as its pair's live rate", () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-01T16:00:00Z");
    vi.setSystemTime(now);
    try {
      const result = writeStreamQuotes([{ symbol: "EURUSD=X", price: 1.1234, timeMs: now.getTime(), previousClose: 1.12 }], now);
      expect(result).toEqual({ changedTickers: [], fxChanged: ["EUR_USD"] });
      expect(getLatestLivePairQuoteRow("EUR_USD", 600_000)?.value).toBe(1.1234);
      expect(getLatestLiveFxQuoteRow(600_000)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-stamps an unchanged price without reporting a change", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-06-01T16:00:00Z");
    vi.setSystemTime(t0);
    try {
      writeStreamQuotes([{ symbol: "SPY", price: 601.25, timeMs: t0.getTime(), previousClose: 590 }], t0);
      const t1 = new Date("2026-06-01T16:03:00Z");
      vi.setSystemTime(t1);
      const again = writeStreamQuotes([{ symbol: "SPY", price: 601.25, timeMs: t0.getTime(), previousClose: 590 }], t1);
      expect(again).toEqual({ changedTickers: [], fxChanged: [] });
      expect(getLatestLiveEquityQuoteRow("SPY", 600_000)?.fetched_at).toBe(t1.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});
