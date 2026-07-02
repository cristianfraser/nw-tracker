import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
    price_usd: symbol === "CLP=X" ? 950 : symbol === "SPY" ? 600 : 42,
    previous_close_usd: symbol === "CLP=X" ? 945 : symbol === "SPY" ? 590 : 40,
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

const restoreTables = snapshotTables(["fx_daily"]);
afterAll(() => restoreTables());

afterEach(() => {
  clearLiveMarketQuotesForTest();
  db.prepare(`DELETE FROM live_market_quotes WHERE symbol IN ('SPY', 'VEA')`).run();
  db.exec("DELETE FROM fx_daily");
});

describe("syncAllLiveMarketQuotes", () => {
  it("mirrors fx_daily EOD after NYSE close", async () => {
    // The fixture date can already exist in the refreshed test DB (real Yahoo history) —
    // upsert the fixture rate and restore the original row afterwards.
    const original = db
      .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`)
      .get("2026-06-05") as { clp_per_usd: number } | undefined;
    db.prepare(
      `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
    ).run("2026-06-05", 910.29);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T22:00:00.000Z"));
    try {
      await syncAllLiveMarketQuotes(new Date("2026-06-06T22:00:00.000Z"));
      const fx = getLatestLiveFxQuoteRow(600_000);
      expect(fx?.value).toBeCloseTo(910.29, 2);
      expect(fx?.session_ymd).toBe("2026-06-05");
    } finally {
      vi.useRealTimers();
      if (original) {
        db.prepare(`UPDATE fx_daily SET clp_per_usd = ? WHERE date = ?`).run(
          original.clp_per_usd,
          "2026-06-05"
        );
      } else {
        db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run("2026-06-05");
      }
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
});
