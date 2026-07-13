import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearLiveMarketQuotesForTest, insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import {
  clearEquityLiveQuoteCache,
  cryptoDisplaySessionYmd,
  equityMarketKind,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  resolveEquityQuote,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { nyseDisplaySessionYmd } from "./nyseSession.js";

const TEST_TICKER = "SPY_TEST_DELTA";
const SN_TEST = "VITEST.SN";
/** Real crypto ticker; use far-future dates so test rows do not collide with production EOD. */
const BTC_TEST = "BTC-USD";
const BTC_TEST_DATE_A = "2099-06-01";
const BTC_TEST_DATE_B = "2099-05-31";

function upsertEod(ticker: string, tradeDate: string, close: number, currency: "usd" | "clp" = "usd"): void {
  db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
  ).run(ticker, tradeDate, close, currency);
}

function deleteTestEod(ticker: string): void {
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
}

afterEach(() => {
  clearEquityLiveQuoteCache();
  clearLiveMarketQuotesForTest();
  deleteTestEod(TEST_TICKER);
  deleteTestEod(SN_TEST);
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
    expect(q!.price).toBe(500);
    expect(q!.previous_close).toBe(400);
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
    expect(q!.price).toBe(510);
    expect(q!.previous_close).toBe(500);
    expect(q!.delta_pct).toBeCloseTo(2, 5);
  });

  it("falls back to the last available prior bar when the exact prior session has no bar", () => {
    // Sparse (e.g. demo weekly) bars: no bar on the calendar prior session (Wed 2026-05-13),
    // so the day change must use the previous available session (Thu 2026-05-07), not go null.
    upsertEod(TEST_TICKER, "2026-05-14", 520);
    upsertEod(TEST_TICKER, "2026-05-07", 500);
    const thuAfterClose = new Date("2026-05-14T17:00:00-04:00");
    const q = resolveEquityQuote(TEST_TICKER, "2026-05-14", {
      preferLive: false,
      now: thuAfterClose,
    });
    expect(q!.trade_date).toBe("2026-05-14");
    expect(q!.price).toBe(520);
    expect(q!.previous_close).toBe(500);
    expect(q!.delta_pct).toBeCloseTo(4, 5);
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
    expect(q!.previous_close).toBe(80);
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
      kind: "equity",
      currency: "usd",
      value: 555,
      session_ymd: "2026-05-19",
      previous_value: 500,
      fetched_at: new Date().toISOString(),
    });
    const tueMid = new Date("2026-05-19T11:00:00-04:00");
    const q = resolveEquityQuote(TEST_TICKER, "2026-05-19", { preferLive: true, now: tueMid });
    expect(q?.source).toBe("live");
    expect(q?.price).toBe(555);
    expect(getLiveEquityQuoteFromDb(TEST_TICKER)?.price).toBe(555);
  });
});

describe("santiago (.SN) market kind + CLP quote currency", () => {
  it("classifies .SN as santiago / clp; others unchanged", () => {
    expect(equityMarketKind(SN_TEST)).toBe("santiago");
    expect(equityQuoteCurrency(SN_TEST)).toBe("clp");
    expect(equityMarketKind("SPY")).toBe("nyse");
    expect(equityQuoteCurrency("SPY")).toBe("usd");
    expect(equityMarketKind("BTC-USD")).toBe("crypto24");
    expect(equityQuoteCurrency("BTC-USD")).toBe("usd");
  });

  it("session date is the Chile calendar day", () => {
    // 2026-05-19 23:30 UTC is still 2026-05-19 in Chile (-04) but would be 05-19 NYSE too;
    // 2026-05-20 03:30 UTC is 2026-05-19 23:30 Chile → still 05-19 in Chile.
    const lateUtc = new Date("2026-05-20T03:30:00Z");
    expect(equitySessionYmdForTicker(SN_TEST, lateUtc)).toBe("2026-05-19");
  });

  it("live window: Chile weekday trading hours only", () => {
    const monMid = new Date("2026-05-25T11:00:00-04:00"); // Monday 11:00 Chile (NYSE holiday, irrelevant)
    expect(shouldUseLiveEquityQuote(SN_TEST, "2026-05-25", monMid)).toBe(true);
    const monPreOpen = new Date("2026-05-25T08:00:00-04:00");
    expect(shouldUseLiveEquityQuote(SN_TEST, "2026-05-25", monPreOpen)).toBe(false);
    const monEvening = new Date("2026-05-25T19:00:00-04:00");
    expect(shouldUseLiveEquityQuote(SN_TEST, "2026-05-25", monEvening)).toBe(false);
    const saturday = new Date("2026-05-23T11:00:00-04:00");
    expect(shouldUseLiveEquityQuote(SN_TEST, "2026-05-23", saturday)).toBe(false);
  });

  it("resolves EOD on-or-before Chile today with prior-row previous close (CLP)", () => {
    upsertEod(SN_TEST, "2026-05-22", 1300, "clp");
    upsertEod(SN_TEST, "2026-05-21", 1250, "clp");
    const now = new Date("2026-05-25T12:00:00-04:00"); // Chile Monday; last bar Friday
    const q = resolveEquityQuote(SN_TEST, "2026-05-25", { preferLive: false, now });
    expect(q).not.toBeNull();
    expect(q!.trade_date).toBe("2026-05-22");
    expect(q!.price).toBe(1300);
    expect(q!.currency).toBe("clp");
    expect(q!.previous_close).toBe(1250);
    expect(q!.delta_pct).toBeCloseTo(4, 5);
  });

  it("fails fast when stored currency mismatches the ticker quote currency", () => {
    upsertEod(SN_TEST, "2026-05-22", 1300, "usd");
    const now = new Date("2026-05-25T12:00:00-04:00");
    expect(() => resolveEquityQuote(SN_TEST, "2026-05-25", { preferLive: false, now })).toThrow(
      /currency mismatch/
    );
  });
});
