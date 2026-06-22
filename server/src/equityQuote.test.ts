import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearLiveMarketQuotesForTest, insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import {
  clearEquityLiveQuoteCache,
  cryptoDisplaySessionYmd,
  getLiveEquityQuoteFromDb,
  resolveEquityQuote,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { nyseDisplaySessionYmd } from "./nyseSession.js";

const TEST_TICKER = "SPY_TEST_DELTA";
/** Real crypto ticker; use far-future dates so test rows do not collide with production EOD. */
const BTC_TEST = "BTC-USD";
const BTC_TEST_DATE_A = "2099-06-01";
const BTC_TEST_DATE_B = "2099-05-31";

function upsertEod(ticker: string, tradeDate: string, closeUsd: number): void {
  db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close_usd) VALUES (?, ?, ?)
     ON CONFLICT(ticker, trade_date) DO UPDATE SET close_usd = excluded.close_usd`
  ).run(ticker, tradeDate, closeUsd);
}

function deleteTestEod(ticker: string): void {
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
}

afterEach(() => {
  clearEquityLiveQuoteCache();
  clearLiveMarketQuotesForTest();
  deleteTestEod(TEST_TICKER);
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date IN (?, ?)`).run(
    BTC_TEST,
    BTC_TEST_DATE_A,
    BTC_TEST_DATE_B
  );
});

describe("shouldUseLiveEquityQuote (NYSE)", () => {
  it("is false on holidays and outside regular hours", () => {
    const memorial = new Date("2026-05-25T12:00:00-04:00");
    expect(shouldUseLiveEquityQuote(TEST_TICKER, "2026-05-22", memorial)).toBe(false);

    const tuePreOpen = new Date("2026-05-19T08:00:00-04:00");
    expect(shouldUseLiveEquityQuote(TEST_TICKER, "2026-05-19", tuePreOpen)).toBe(false);

    const tueAfterClose = new Date("2026-05-19T17:00:00-04:00");
    expect(shouldUseLiveEquityQuote(TEST_TICKER, "2026-05-19", tueAfterClose)).toBe(false);
  });

  it("is true during regular session", () => {
    const tueMid = new Date("2026-05-19T11:00:00-04:00");
    expect(shouldUseLiveEquityQuote(TEST_TICKER, "2026-05-19", tueMid)).toBe(true);
  });
});

describe("resolveEquityQuote NYSE session pair", () => {
  it("returns Fri vs Thu delta on Memorial Day (not 0)", () => {
    upsertEod(TEST_TICKER, "2026-05-22", 500);
    upsertEod(TEST_TICKER, "2026-05-21", 400);
    const memorial = new Date("2026-05-25T18:00:00-04:00");
    const q = resolveEquityQuote(TEST_TICKER, nyseDisplaySessionYmd(memorial), {
      preferLive: false,
      now: memorial,
    });
    expect(q).not.toBeNull();
    expect(q!.trade_date).toBe("2026-05-22");
    expect(q!.price_usd).toBe(500);
    expect(q!.previous_close_usd).toBe(400);
    expect(q!.delta_pct).toBeCloseTo(25, 5);
    expect(q!.delta_pct).not.toBe(0);
  });

  it("returns Mon vs Fri after Monday close", () => {
    upsertEod(TEST_TICKER, "2026-05-18", 510);
    upsertEod(TEST_TICKER, "2026-05-15", 500);
    const monAfterClose = new Date("2026-05-18T17:00:00-04:00");
    const q = resolveEquityQuote(TEST_TICKER, "2026-05-18", {
      preferLive: false,
      now: monAfterClose,
    });
    expect(q!.trade_date).toBe("2026-05-18");
    expect(q!.delta_pct).toBeCloseTo(2, 5);
  });

  it("returns Mon vs Fri before Tuesday open", () => {
    upsertEod(TEST_TICKER, "2026-05-18", 510);
    upsertEod(TEST_TICKER, "2026-05-15", 500);
    const tuePreOpen = new Date("2026-05-19T08:00:00-04:00");
    const q = resolveEquityQuote(TEST_TICKER, "2026-05-19", {
      preferLive: false,
      now: tuePreOpen,
    });
    expect(q!.trade_date).toBe("2026-05-18");
    expect(q!.price_usd).toBe(510);
    expect(q!.previous_close_usd).toBe(500);
    expect(q!.delta_pct).toBeCloseTo(2, 5);
  });
});

describe("resolveEquityQuote crypto session pair", () => {
  it("uses last completed UTC day vs prior when not live", () => {
    upsertEod(BTC_TEST, BTC_TEST_DATE_A, 100);
    upsertEod(BTC_TEST, BTC_TEST_DATE_B, 80);
    const now = new Date("2099-06-02T01:00:00Z");
    const display = cryptoDisplaySessionYmd(BTC_TEST, now);
    expect(display).toBe(BTC_TEST_DATE_A);
    const q = resolveEquityQuote(BTC_TEST, display, { preferLive: false, now });
    expect(q!.trade_date).toBe(BTC_TEST_DATE_A);
    expect(q!.previous_close_usd).toBe(80);
    expect(q!.delta_pct).toBeCloseTo(25, 5);
    expect(q!.delta_pct).not.toBe(0);
  });

  it("ignores in-progress UTC day row for display", () => {
    upsertEod(BTC_TEST, BTC_TEST_DATE_A, 100);
    upsertEod(BTC_TEST, BTC_TEST_DATE_B, 80);
    const inProgress = "2099-06-02";
    upsertEod(BTC_TEST, inProgress, 999);
    const now = new Date(`${inProgress}T15:00:00Z`);
    expect(cryptoDisplaySessionYmd(BTC_TEST, now)).toBe(BTC_TEST_DATE_A);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date = ?`).run(
      BTC_TEST,
      inProgress
    );
  });
});

describe("getLiveEquityQuoteFromDb", () => {
  it("reads scheduler-persisted quote during live session", () => {
    insertLiveMarketQuote({
      symbol: TEST_TICKER,
      kind: "equity_usd",
      value: 555,
      session_ymd: "2026-05-19",
      previous_value: 500,
      fetched_at: new Date().toISOString(),
    });
    const tueMid = new Date("2026-05-19T11:00:00-04:00");
    const q = resolveEquityQuote(TEST_TICKER, "2026-05-19", { preferLive: true, now: tueMid });
    expect(q?.source).toBe("live");
    expect(q?.price_usd).toBe(555);
    expect(getLiveEquityQuoteFromDb(TEST_TICKER)?.price_usd).toBe(555);
  });
});
