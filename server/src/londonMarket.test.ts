import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import type { ChileWallClock } from "./chileDate.js";
import { dateAtTimeZoneWallClock } from "./chileDate.js";
import {
  equityDisplaySessionYmd,
  equityHeldSessionQuote,
  equityMarketKind,
  equityQuoteCurrency,
  equitySessionClosedForDay,
  equitySessionYmdForTicker,
  isEquityRegularSessionOpen,
  resolveEquityQuote,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { equityEodLondonSyncDue, isLondonEodSyncWindow } from "./equityEodSync.js";
import { yahooBarYmdFromUnix } from "./equityYahooEod.js";
import { SYNC_SOURCES, attachSyncSourceSchedule, isStocksLondonStale } from "./globalSyncStale.js";
import { loadGlobalSyncState } from "./globalSyncState.js";
import { clearLiveMarketQuotesForTest, insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import {
  isAfterLondonRegularClose,
  isLondonRegularSessionOpen,
  londonDisplaySessionYmd,
  londonSessionYmd,
  londonWallClock,
} from "./londonSession.js";
import { isLondonTradingDay, londonSessionsBack, priorLondonSessionYmd } from "./marketHolidays.js";
import { registerMarketSymbol } from "./marketSymbols.js";
import { displayDayPct, equityTickerDayCalendar, tickerMarketOpenOnYmd } from "./tickerDayDisplay.js";
import { inferSyncSourcesForAccount } from "./accountSyncSources.js";
import { classifyYahooSymbol } from "./yahooSymbols.js";
import { LONDON_FIXTURE_TICKER, installLondonTickerFixture, removeLondonTickerFixture } from "./test/londonTickerFixture.js";

/** The instant the Europe/London wall clock reads `ymd` HH:mm. */
function london(ymd: string, hour: number, minute = 0): Date {
  return dateAtTimeZoneWallClock(ymd, hour, minute, "Europe/London");
}

function chileClock(ymd: string, hour: number, minute = 0): ChileWallClock {
  const [ys, ms, ds] = ymd.split("-");
  return { ymd, year: Number(ys), month: Number(ms), day: Number(ds), hour, minute, monthKey: ymd.slice(0, 7) };
}

const TEST_TICKER = "VITEST.L";

afterEach(() => {
  clearLiveMarketQuotesForTest();
  // The 2026 bars the session tests plant; the fixture's 2050 bar stays for the stale tests.
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ? AND trade_date < '2050-01-01'`).run(TEST_TICKER);
});

describe("equityMarketKind: an exchange suffix must be known", () => {
  it("maps .SN to Santiago, .L to London, bare symbols to NYSE, coins to crypto", () => {
    expect(equityMarketKind("CFIETFIPSA.SN")).toBe("santiago");
    expect(equityMarketKind("CSPX.L")).toBe("london");
    expect(equityMarketKind("vwra.l")).toBe("london");
    expect(equityMarketKind("SPY")).toBe("nyse");
    expect(equityMarketKind("BRK-B")).toBe("nyse");
    expect(equityMarketKind("BTC-USD")).toBe("crypto24");
  });

  it("throws on a suffix nothing knows (Paris) instead of falling back to NYSE", () => {
    expect(() => equityMarketKind("XYZ.PA")).toThrow(/unknown exchange suffix \.PA/);
    expect(() => equityMarketKind("ABC.DE")).toThrow(/unknown exchange suffix \.DE/);
  });

  it("lets a market_symbols row win over the suffix", () => {
    registerMarketSymbol({
      ticker: "VITESTREG.PA",
      quote_currency: "usd",
      market_kind: "nyse",
      name: null,
      exchange: null,
      instrument_type: null,
      verified_at: "2026-11-10T00:00:00.000Z",
    });
    try {
      expect(equityMarketKind("VITESTREG.PA")).toBe("nyse");
    } finally {
      db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run("VITESTREG.PA");
    }
  });

  it("a .L line is valued in USD by the suffix rule (Yahoo's currency is checked at every write)", () => {
    expect(equityQuoteCurrency("CSPX.L")).toBe("usd");
  });
});

describe("the LSE calendar (England and Wales bank holidays, half days as full sessions)", () => {
  it("closes on bank holidays and their substitute days, trades on the December half days", () => {
    expect(isLondonTradingDay("2026-12-28")).toBe(false); // Boxing Day substitute (Monday)
    expect(isLondonTradingDay("2023-05-08")).toBe(false); // the coronation
    expect(isLondonTradingDay("2024-05-06")).toBe(false); // Early May bank holiday
    expect(isLondonTradingDay("2024-12-24")).toBe(true);
    expect(isLondonTradingDay("2024-12-31")).toBe(true);
    expect(isLondonTradingDay("2026-11-07")).toBe(false); // Saturday
    // A Chilean holiday and a US holiday the LSE trades on.
    expect(isLondonTradingDay("2026-09-18")).toBe(true);
    expect(isLondonTradingDay("2026-07-03")).toBe(true);
  });

  it("walks prior sessions over the Christmas block", () => {
    expect(priorLondonSessionYmd("2026-12-29")).toBe("2026-12-24");
    expect(londonSessionsBack("2027-01-04", 5)).toBe("2026-12-23");
  });
});

describe("the London session gates at fixed instants", () => {
  it("10:00 London on a weekday is live (GMT in November, BST in July)", () => {
    const nov = london("2026-11-04", 10, 0);
    expect(londonWallClock(nov)).toMatchObject({ ymd: "2026-11-04", hour: 10, minute: 0 });
    expect(nov.toISOString()).toBe("2026-11-04T10:00:00.000Z");
    expect(isLondonRegularSessionOpen(nov)).toBe(true);
    expect(isEquityRegularSessionOpen("london", nov)).toBe(true);
    expect(shouldUseLiveEquityQuote("CSPX.L", "2026-11-04", nov)).toBe(true);
    expect(equitySessionClosedForDay("CSPX.L", nov)).toBe(false);
    expect(equitySessionYmdForTicker("CSPX.L", nov)).toBe("2026-11-04");
    expect(equityDisplaySessionYmd("CSPX.L", nov)).toBe("2026-11-04");

    const jul = london("2026-07-15", 10, 0);
    expect(jul.toISOString()).toBe("2026-07-15T09:00:00.000Z");
    expect(isLondonRegularSessionOpen(jul)).toBe(true);
    expect(isLondonRegularSessionOpen(london("2026-07-15", 16, 30))).toBe(true);
    expect(isLondonRegularSessionOpen(london("2026-07-15", 16, 31))).toBe(false);
    expect(isLondonRegularSessionOpen(london("2026-07-15", 7, 59))).toBe(false);
  });

  it("17:00 London holds the session's last print until the bar lands", () => {
    const at = london("2026-11-04", 17, 0);
    expect(isAfterLondonRegularClose(at)).toBe(true);
    expect(shouldUseLiveEquityQuote(TEST_TICKER, "2026-11-04", at)).toBe(false);
    expect(equitySessionClosedForDay(TEST_TICKER, at)).toBe(true);
    insertLiveMarketQuote({
      symbol: TEST_TICKER,
      kind: "equity",
      value: 810.5,
      currency: "usd",
      session_ymd: "2026-11-04",
      previous_value: 802.2,
      fetched_at: london("2026-11-04", 16, 29).toISOString(),
    });
    const held = equityHeldSessionQuote(TEST_TICKER, at);
    expect(held).toMatchObject({ price: 810.5, trade_date: "2026-11-04", source: "live", previous_close: 802.2 });
    expect(resolveEquityQuote(TEST_TICKER, "2026-11-04", { preferLive: true, now: at })).toMatchObject({ price: 810.5, source: "live" });
    // Once the EOD sync has written the bar, the bar wins.
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-11-04', 811.9, 'usd')`).run(TEST_TICKER);
    expect(equityHeldSessionQuote(TEST_TICKER, at)).toBeNull();
  });

  it("before the open shows the prior session's bar against the one before it", () => {
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-11-02', 800, 'usd')`).run(TEST_TICKER);
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-11-03', 804, 'usd')`).run(TEST_TICKER);
    const at = london("2026-11-04", 7, 30);
    expect(londonDisplaySessionYmd(at)).toBe("2026-11-03");
    expect(resolveEquityQuote(TEST_TICKER, "2026-11-04", { preferLive: true, now: at })).toMatchObject({
      price: 804,
      trade_date: "2026-11-03",
      previous_close: 800,
      source: "eod",
    });
  });

  it("a UK bank holiday is closed: no live window, a 0 day change, the last session's bar", () => {
    const holiday = london("2026-12-28", 10, 0); // Boxing Day substitute; NYSE and the Bolsa trade
    expect(isLondonRegularSessionOpen(holiday)).toBe(false);
    expect(isAfterLondonRegularClose(holiday)).toBe(false);
    expect(shouldUseLiveEquityQuote("CSPX.L", "2026-12-28", holiday)).toBe(false);
    expect(equitySessionClosedForDay("CSPX.L", holiday)).toBe(false);
    expect(londonSessionYmd(holiday)).toBe("2026-12-24");
    expect(equityTickerDayCalendar("CSPX.L")).toBe("london");
    expect(tickerMarketOpenOnYmd("london", "2026-12-28")).toBe(false);
    expect(tickerMarketOpenOnYmd("london", "2026-12-24")).toBe(true);
    expect(displayDayPct("london", "2026-12-28", 1.2)).toBe(0);
    expect(displayDayPct("nyse", "2026-12-28", 1.2)).toBe(1.2);
  });

  it("labels a Yahoo bar by its London day (Yahoo stamps LSE bars at the 08:00 open)", () => {
    expect(yahooBarYmdFromUnix("CSPX.L", 1794297600)).toBe("2026-11-10");
    // 23:30 New York on the 9th is 04:30 London on the 10th: the London day, never New York's.
    expect(yahooBarYmdFromUnix("CSPX.L", Math.floor(dateAtTimeZoneWallClock("2026-11-09", 23, 30, "America/New_York").getTime() / 1000))).toBe("2026-11-10");
  });
});

describe("classifyYahooSymbol: Europe/London in USD only", () => {
  it("reads a USD LSE line as london / usd and refuses a pence line", () => {
    const meta = { regularMarketPrice: 810.47, currency: "USD", instrumentType: "ETF", exchangeTimezoneName: "Europe/London", fullExchangeName: "LSE" };
    expect(classifyYahooSymbol("CSPX.L", meta, new Date("2026-11-10T12:00:00Z"))).toMatchObject({
      ticker: "CSPX.L",
      quote_currency: "usd",
      market_kind: "london",
    });
    expect(() => classifyYahooSymbol("VWRL.L", { ...meta, currency: "GBp" })).toThrow(/quoted in GBp/);
  });
});

describe("stocks_london: the EOD due rule, carry-over and the source row", () => {
  beforeAll(() => installLondonTickerFixture());
  afterAll(() => removeLondonTickerFixture());

  it("is due today from 16:40 London on an LSE trading day, the prior session before that", () => {
    expect(isLondonEodSyncWindow(londonWallClock(london("2026-11-04", 16, 39)))).toBe(false);
    expect(isLondonEodSyncWindow(londonWallClock(london("2026-11-04", 16, 40)))).toBe(true);
    expect(equityEodLondonSyncDue(london("2026-11-04", 16, 39))).toBe("2026-11-03");
    expect(equityEodLondonSyncDue(london("2026-11-04", 16, 40))).toBe("2026-11-04");
    expect(equityEodLondonSyncDue(london("2026-11-04", 23, 50))).toBe("2026-11-04");
  });

  it("carries over the last closed LSE session through the weekend and UK bank holidays", () => {
    expect(equityEodLondonSyncDue(london("2026-11-07", 12, 0))).toBe("2026-11-06"); // Saturday
    expect(equityEodLondonSyncDue(london("2026-12-28", 18, 0))).toBe("2026-12-24"); // Boxing Day substitute
    // A Chilean holiday the LSE trades on is due like any trading day.
    expect(equityEodLondonSyncDue(london("2026-09-18", 17, 0))).toBe("2026-09-18");
  });

  it("is stale while the due session's bar is missing, not once every .L ticker has it", () => {
    const state = loadGlobalSyncState();
    expect(isStocksLondonStale(state, { now: london("2026-11-04", 17, 0) })).toBe(false); // fixture bar at 2050
    expect(isStocksLondonStale(state, { now: london("2099-06-03", 17, 0) })).toBe(true);
    expect(isStocksLondonStale(state, { force: true, now: london("2026-11-04", 17, 0) })).toBe(true);
  });

  it("has its source row: London day kind, 16:40 London next sync, forced runs kept while stale", () => {
    const def = SYNC_SOURCES.stocks_london;
    expect(def.label).toBe("London stocks");
    expect(def.keepsForcedWhileStale).toBe(true);
    // 08:00 Chile on 2026-11-04 is 11:00 London: the bar is due at 16:40 London today.
    const open = attachSyncSourceSchedule("stocks_london", chileClock("2026-11-04", 8, 0), false, false);
    expect(open.today_day_kind).toBe("open");
    expect(open.next_sync).toEqual({ ymd: "2026-11-04", hour: 16, minute: 40, timeZone: "Europe/London" });
    // The Boxing Day substitute is a holiday on London's calendar although Chile and New York trade.
    const holiday = attachSyncSourceSchedule("stocks_london", chileClock("2026-12-28", 10, 0), false, false);
    expect(holiday.today_day_kind).toBe("holiday");
    expect(holiday.next_sync).toEqual({ ymd: "2026-12-29", hour: 16, minute: 40, timeZone: "Europe/London" });
    // Stale reads imminent, still with London's day kind.
    expect(attachSyncSourceSchedule("stocks_london", chileClock("2026-12-28", 10, 0), true, false)).toMatchObject({
      next_sync_imminent: true,
      today_day_kind: "holiday",
    });
  });

  it("a .L account infers the stocks_london source", () => {
    expect(inferSyncSourcesForAccount({ id: 0, import_key: null, equity_ticker: LONDON_FIXTURE_TICKER, fund_series_key: null })).toEqual(["stocks_london"]);
  });
});
