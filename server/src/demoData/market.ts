/**
 * Market data for the synthetic databases. Two sources, one reader:
 *
 * - `real` (the hosted demo): `loadDemoRealMarket` filled the tables from Yahoo, the Banco Central
 *   and AFP UNO before generation; nothing here writes prices.
 * - `synthetic` (offline runs, CI): `writeSyntheticMarket` writes era-shaped series for every table
 *   the person's documents need (fx, UF, UTM, IPC, equity closes, the AFP fund values).
 *
 * The simulation only ever reads prices back from the database (`MarketReader`), so a holding is
 * valued by the generator exactly as the app values it.
 */
import { db } from "../db.js";
import { fxRowOnOrBefore, ufRowOnOrBefore } from "../fxRates.js";
import { isChileBusinessDay, isLondonTradingDay, isNyseTradingDay, isWeekendYmd } from "../marketHolidays.js";
import { equityMarketKind, equityQuoteCurrency, unknownEquityMarketKind } from "../equityQuote.js";
import { registerInstrument, type InstrumentFacts, type MarketQuoteCurrency, type MarketSymbolKind } from "../marketSymbols.js";
import { upsertSpAfpFundUnits, type SpAfpFundUnitRow } from "../spAfpFundUnits.js";
import { stream } from "./rng.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { addDays, addMonths, BTC_TICKER, DEMO_PERSON, type Month, type Person, type Ymd } from "./person.js";

/**
 * An instrument the synthetic databases hold, with the facts the generator declares for it
 * (`market_symbols`, source `declared`): the synthetic path never asks a provider, and the
 * real-market loader cross-checks each declaration against Yahoo's statement (`demoRealMarket.ts`).
 */
export type DemoInstrument = {
  ticker: string;
  firstUse: Ymd;
  market_kind: MarketSymbolKind;
  quote_currency: MarketQuoteCurrency;
  display_symbol: string;
  /** ISO 10383; null for a coin. */
  mic: string | null;
  name: string;
  instrument_type: string;
};

const us = (ticker: string, firstUse: Ymd, mic: string, name: string, instrument_type: "EQUITY" | "ETF"): DemoInstrument => ({
  ticker,
  firstUse,
  market_kind: "nyse",
  quote_currency: "usd",
  display_symbol: ticker,
  mic,
  name,
  instrument_type,
});

/** Every ticker the person holds, with the first day the story needs its price and its declared facts. */
export const DEMO_TICKERS: DemoInstrument[] = [
  us("SPY", "2018-05-01", "ARCX", "SPDR S&P 500 ETF Trust", "ETF"),
  us("AAPL", "2019-03-01", "XNAS", "Apple Inc.", "EQUITY"),
  us("AMD", "2019-07-01", "XNAS", "Advanced Micro Devices, Inc.", "EQUITY"),
  us("MSFT", "2020-04-01", "XNAS", "Microsoft Corporation", "EQUITY"),
  us("ZM", "2020-10-01", "XNAS", "Zoom Communications, Inc.", "EQUITY"),
  us("NVDA", "2021-03-01", "XNAS", "NVIDIA Corporation", "EQUITY"),
  us("INTC", "2021-04-01", "XNAS", "Intel Corporation", "EQUITY"),
  us("OILK", "2026-05-01", "BATS", "ProShares K-1 Free Crude Oil ETF", "ETF"),
  us("LNG", "2026-05-01", "XASE", "Cheniere Energy, Inc.", "EQUITY"),
  us("SGOV", "2024-05-01", "ARCX", "iShares 0-3 Month Treasury Bond ETF", "ETF"),
  {
    ticker: "CFIETFIPSA.SN",
    firstUse: "2025-06-01",
    market_kind: "santiago",
    quote_currency: "clp",
    display_symbol: "CFIETFIPSA",
    mic: "XSGO",
    name: "ETF IPSA",
    instrument_type: "ETF",
  },
  // The Irish UCITS ETFs on the LSE's USD lines, held at IBKR as a Chilean resident (2023-05 → 2024-03).
  { ticker: "CSPX.L", firstUse: "2023-05-01", market_kind: "london", quote_currency: "usd", display_symbol: "CSPX", mic: "XLON", name: "iShares Core S&P 500 UCITS ETF USD (Acc)", instrument_type: "ETF" },
  { ticker: "VWRA.L", firstUse: "2023-05-01", market_kind: "london", quote_currency: "usd", display_symbol: "VWRA", mic: "XLON", name: "Vanguard FTSE All-World UCITS ETF USD Accumulation", instrument_type: "ETF" },
  { ticker: BTC_TICKER, firstUse: "2018-06-01", market_kind: "crypto24", quote_currency: "usd", display_symbol: BTC_TICKER, mic: null, name: "Bitcoin USD", instrument_type: "CRYPTOCURRENCY" },
];

/** The declared facts of a demo instrument, as `registerInstrument` takes them. */
export function demoInstrumentFacts(i: DemoInstrument): InstrumentFacts {
  return {
    quote_currency: i.quote_currency,
    market_kind: i.market_kind,
    mic: i.mic,
    exchange: null,
    name: i.name,
    instrument_type: i.instrument_type,
    display_symbol: i.display_symbol,
  };
}

/**
 * Registers the declared facts of `tickers` (default: every demo instrument), source `declared`.
 * A ticker without a declaration throws: the synthetic databases hold nothing undeclared.
 */
export function declareDemoInstruments(tickers: readonly string[] = DEMO_TICKERS.map((t) => t.ticker)): void {
  for (const ticker of tickers) {
    const i = DEMO_TICKERS.find((t) => t.ticker === ticker);
    if (!i) throw new Error(`demo: ${ticker} has no declared instrument facts (DEMO_TICKERS in demoData/market.ts)`);
    registerInstrument(ticker, demoInstrumentFacts(i), "declared");
  }
}

/* ------------------------------- synthetic -------------------------------------- */

type Anchor = [Ymd, number];

/** Split-adjusted USD levels, roughly the decade's shape (real runs use the real closes). */
const EQUITY_ANCHORS: Record<string, readonly Anchor[]> = {
  SPY: [["2015-01-01", 205], ["2016-02-10", 185], ["2018-01-26", 285], ["2018-12-24", 235], ["2020-02-19", 338], ["2020-03-23", 222], ["2021-12-31", 475], ["2022-10-12", 357], ["2023-12-31", 475], ["2024-12-31", 588], ["2025-04-08", 496], ["2025-12-31", 680], ["2026-12-31", 700]],
  AAPL: [["2015-01-01", 27], ["2016-05-12", 22], ["2018-10-03", 56], ["2019-01-03", 35], ["2019-12-31", 72], ["2020-03-23", 56], ["2021-12-31", 177], ["2023-01-05", 125], ["2023-12-31", 192], ["2024-12-26", 259], ["2025-04-08", 172], ["2025-12-31", 265], ["2026-12-31", 275]],
  AMD: [["2015-01-01", 2.7], ["2016-01-20", 1.8], ["2018-09-13", 32], ["2019-07-15", 33], ["2020-03-16", 39], ["2020-12-31", 92], ["2021-11-30", 158], ["2022-10-13", 56], ["2024-03-07", 211], ["2025-04-08", 78], ["2025-10-31", 255], ["2026-12-31", 245]],
  MSFT: [["2015-01-01", 46], ["2016-02-10", 49], ["2018-12-24", 94], ["2020-02-10", 188], ["2020-03-16", 135], ["2021-11-19", 343], ["2022-11-03", 214], ["2024-07-05", 467], ["2025-04-08", 354], ["2025-10-28", 540], ["2026-12-31", 520]],
  ZM: [["2019-04-18", 62], ["2020-01-02", 69], ["2020-10-19", 559], ["2021-02-16", 400], ["2022-05-11", 82], ["2022-12-31", 68], ["2024-12-31", 82], ["2026-12-31", 88]],
  NVDA: [["2015-01-01", 0.5], ["2016-01-20", 0.6], ["2018-10-01", 7.2], ["2018-12-24", 3.2], ["2020-03-16", 4.9], ["2020-12-31", 13], ["2021-03-15", 13.5], ["2021-11-29", 33], ["2022-10-13", 11.2], ["2023-05-26", 39], ["2024-02-15", 73], ["2024-06-18", 135], ["2025-01-06", 149], ["2025-04-08", 97], ["2025-10-29", 207], ["2026-12-31", 215]],
  INTC: [["2015-01-01", 36], ["2016-02-11", 28], ["2018-04-30", 52], ["2020-01-24", 68], ["2021-04-20", 64], ["2022-10-13", 25], ["2023-12-27", 50], ["2024-08-05", 19.5], ["2025-04-08", 18.5], ["2025-09-30", 34], ["2026-12-31", 38]],
  OILK: [["2020-04-21", 18], ["2022-06-08", 52], ["2023-06-30", 42], ["2025-12-31", 38], ["2026-05-12", 61], ["2026-06-23", 42], ["2026-12-31", 41]],
  LNG: [["2015-01-01", 70], ["2016-02-11", 30], ["2020-03-18", 28], ["2022-10-14", 175], ["2024-12-31", 215], ["2026-05-12", 255], ["2026-12-31", 290]],
  // A T-bill ETF: flat (its interest is paid out monthly).
  SGOV: [["2020-05-26", 100.1], ["2026-12-31", 100.5]],
  // The LSE's USD lines of the Irish UCITS ETFs (accumulating; Yahoo's closes, rounded): the S&P 500 and the all-world.
  "CSPX.L": [["2023-01-03", 400], ["2023-05-02", 425], ["2023-10-27", 420], ["2023-12-29", 475], ["2024-03-12", 542], ["2024-12-31", 629], ["2025-04-08", 530], ["2025-12-31", 739], ["2026-11-10", 810], ["2026-12-31", 815]],
  "VWRA.L": [["2023-01-03", 97], ["2023-05-02", 104], ["2023-10-27", 100], ["2023-12-29", 112], ["2024-03-12", 126], ["2024-12-31", 139], ["2025-04-08", 120], ["2025-12-31", 171], ["2026-11-10", 187], ["2026-12-31", 189]],
  // The IPSA ETF in pesos (listed 2025-05; the Bolsa de Santiago's closes, rounded).
  "CFIETFIPSA.SN": [["2025-05-12", 1_008], ["2025-06-18", 978], ["2025-09-01", 1_081], ["2025-12-19", 1_252], ["2026-01-28", 1_408], ["2026-03-04", 1_266], ["2026-05-15", 1_255], ["2026-09-02", 1_395], ["2026-11-06", 1_281], ["2026-12-31", 1_300]],
  [BTC_TICKER]: [["2015-01-01", 315], ["2016-01-01", 430], ["2017-12-17", 19_100], ["2018-12-15", 3_250], ["2019-06-26", 12_900], ["2020-03-12", 4_900], ["2021-04-14", 63_500], ["2021-07-20", 29_800], ["2021-11-08", 67_500], ["2022-11-21", 15_800], ["2024-03-14", 73_000], ["2024-12-17", 106_000], ["2025-04-08", 77_000], ["2025-10-06", 124_000], ["2026-12-31", 110_000]],
};

const FX_ANCHORS: readonly Anchor[] = [
  ["2015-01-01", 607], ["2016-01-20", 722], ["2016-12-31", 669], ["2017-12-31", 615], ["2018-12-31", 694], ["2019-11-28", 828], ["2020-03-19", 867], ["2020-12-31", 711], ["2021-11-30", 830], ["2022-07-14", 1_040], ["2022-12-31", 855], ["2023-12-31", 877], ["2024-09-06", 945], ["2024-12-31", 994], ["2025-12-31", 935], ["2026-12-31", 925],
];
const UF_ANCHORS: readonly Anchor[] = [
  ["2015-01-01", 24_627], ["2016-01-01", 25_629], ["2017-01-01", 26_348], ["2018-01-01", 26_799], ["2019-01-01", 27_565], ["2020-01-01", 28_310], ["2021-01-01", 29_070], ["2022-01-01", 30_996], ["2023-01-01", 35_110], ["2024-01-01", 36_789], ["2025-01-01", 38_419], ["2026-01-01", 39_730], ["2027-01-01", 40_900],
];
const UTM_ANCHORS: readonly Anchor[] = [
  ["2015-01-01", 43_068], ["2016-01-01", 44_955], ["2017-01-01", 46_183], ["2018-01-01", 46_972], ["2019-01-01", 48_353], ["2020-01-01", 49_673], ["2021-01-01", 51_029], ["2022-01-01", 54_171], ["2023-01-01", 61_769], ["2024-01-01", 64_666], ["2025-01-01", 67_429], ["2026-01-01", 69_751], ["2027-01-01", 72_000],
];

/** Daily noise of a ticker that does not move like a stock (default: 0,8 %, 2 % for a coin). */
const TICKER_NOISE_SD: Record<string, number> = { SGOV: 0.0003 };

function daysSinceEpoch(d: Ymd): number {
  return Date.parse(`${d}T00:00:00Z`) / 86_400_000;
}

/** Log-linear interpolation between anchors; flat outside them. */
export function anchorValue(anchors: readonly Anchor[], d: Ymd): number {
  const t = daysSinceEpoch(d);
  if (t <= daysSinceEpoch(anchors[0]![0])) return anchors[0]![1];
  for (let i = 1; i < anchors.length; i++) {
    const [d1, p1] = anchors[i]!;
    const t1 = daysSinceEpoch(d1);
    if (t <= t1) {
      const [d0, p0] = anchors[i - 1]!;
      const t0 = daysSinceEpoch(d0);
      const w = (t - t0) / (t1 - t0);
      return Math.exp(Math.log(p0) + w * (Math.log(p1) - Math.log(p0)));
    }
  }
  return anchors[anchors.length - 1]![1];
}

/**
 * Writes the synthetic market from `fromMonth` through `lastDay`: fx (CLP=X and the observado),
 * UF daily, UTM and IPC monthly, weekday equity closes (BTC every day) with a little seeded noise,
 * and the AFP fund A values (Modelo from the committed snapshot, UNO synthetic from 2019-10).
 */
export function writeSyntheticMarket(person: Person, fromMonth: Month, lastDay: Ymd, modeloRows: SpAfpFundUnitRow[]): void {
  const seed = person.seed;
  const tickers = new Set([...person.brokerTickers, ...(person.btc ? [BTC_TICKER] : [])]);
  const insFx = db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
  const insFxB = db.prepare(`INSERT OR REPLACE INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`);
  const insUf = db.prepare(`INSERT OR REPLACE INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`);
  const insUtm = db.prepare(`INSERT OR REPLACE INTO utm_daily (date, utm_clp) VALUES (?, ?)`);
  const insIpc = db.prepare(`INSERT OR REPLACE INTO ipc_daily (date, ipc_index) VALUES (?, ?)`);
  const insEq = db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, ?)`);
  const fxNoise = stream(seed, "market|fx");
  const start: Ymd = `${fromMonth}-01`;
  const ufEnd = addDays(lastDay, 40);
  db.transaction(() => {
    for (let d = start; d <= ufEnd; d = addDays(d, 1)) {
      insUf.run(d, Math.round(anchorValue(UF_ANCHORS, d) * 100) / 100);
      if (d > lastDay || isWeekendYmd(d)) continue;
      const fx = Math.round(anchorValue(FX_ANCHORS, d) * (1 + fxNoise.gauss() * 0.004) * 100) / 100;
      insFx.run(d, fx);
      insFxB.run(d, fx);
    }
    for (let m = fromMonth; `${m}-01` <= ufEnd; m = addMonths(m, 1)) {
      insUtm.run(`${m}-01`, Math.round(anchorValue(UTM_ANCHORS, `${m}-01`)));
      insIpc.run(`${m}-01`, Math.round((anchorValue(UF_ANCHORS, `${m}-01`) / 35_110) * 100 * 1e6) / 1e6);
    }
    for (const ticker of tickers) {
      const anchors = EQUITY_ANCHORS[ticker];
      if (!anchors) throw new Error(`demo: no synthetic price anchors for ${ticker}`);
      const noise = stream(seed, `market|${ticker}`);
      const kind = equityMarketKind(ticker);
      const currency = equityQuoteCurrency(ticker);
      const sd = TICKER_NOISE_SD[ticker] ?? (kind === "crypto24" ? 0.02 : 0.008);
      // Each market's own trading days (a coin every day).
      const tradesOn = (d: Ymd): boolean => {
        switch (kind) {
          case "nyse":
            return isNyseTradingDay(d);
          case "santiago":
            return isChileBusinessDay(d);
          case "london":
            return isLondonTradingDay(d);
          case "crypto24":
            return true;
          default:
            return unknownEquityMarketKind(kind);
        }
      };
      for (let d = start < anchors[0]![0] ? anchors[0]![0] : start; d <= lastDay; d = addDays(d, 1)) {
        if (!tradesOn(d)) continue;
        insEq.run(ticker, d, Math.round(anchorValue(anchors, d) * (1 + noise.gauss() * sd) * 100) / 100, currency);
      }
    }
  })();
  upsertSpAfpFundUnits(modeloRows, { dryRun: false });
  upsertSpAfpFundUnits(syntheticUnoRows(lastDay), { dryRun: false });
}

/** UNO fund A from its opening (2019-10-01), drifting ~6 %/yr with SPY-shaped wobbles. */
function syntheticUnoRows(lastDay: Ymd): SpAfpFundUnitRow[] {
  const rows: SpAfpFundUnitRow[] = [];
  const spy = EQUITY_ANCHORS.SPY!;
  const spy0 = anchorValue(spy, "2019-10-01");
  for (let d: Ymd = "2019-10-01"; d <= lastDay; d = addDays(d, 1)) {
    const years = (daysSinceEpoch(d) - daysSinceEpoch("2019-10-01")) / 365.25;
    const v = 1_000 * Math.pow(1.035, years) * (0.55 + 0.45 * (anchorValue(spy, d) / spy0));
    rows.push({ afp: "uno", fund: "A", day: d, unit_value: Math.round(v * 100) / 100, provisional: false });
  }
  return rows;
}

/* --------------------------------- reader --------------------------------------- */

export type MarketReader = {
  fx(day: Ymd): number;
  uf(day: Ymd): number;
  /** The UTM of a month. */
  utm(month: Month): number;
  /** Last stored close on or before `day` (USD). */
  close(ticker: string, day: Ymd): number;
  /** A fund series value on or before `day`. */
  fundUnit(seriesKey: string, day: Ymd): number;
};

export function dbMarketReader(): MarketReader {
  const closes = new Map<string, { d: string[]; c: number[] }>();
  const series = (ticker: string) => {
    let s = closes.get(ticker);
    if (!s) {
      const rows = db.prepare(`SELECT trade_date, close FROM equity_daily WHERE ticker = ? ORDER BY trade_date`).all(ticker) as {
        trade_date: string;
        close: number;
      }[];
      if (rows.length === 0) throw new Error(`demo: no closes for ${ticker}`);
      s = { d: rows.map((r) => r.trade_date), c: rows.map((r) => r.close) };
      closes.set(ticker, s);
    }
    return s;
  };
  const onOrBefore = (s: { d: string[]; c: number[] }, day: Ymd, label: string) => {
    let lo = 0;
    let hi = s.d.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.d[mid]! <= day) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) throw new Error(`demo: no ${label} on or before ${day}`);
    return s.c[found]!;
  };
  const fundCache = new Map<string, { d: string[]; c: number[] }>();
  return {
    fx(day) {
      const r = fxRowOnOrBefore(day)?.clp_per_usd;
      if (r == null) throw new Error(`demo: no fx on or before ${day}`);
      return r;
    },
    uf(day) {
      const r = ufRowOnOrBefore(day)?.clp_per_uf;
      if (r == null) throw new Error(`demo: no UF on or before ${day}`);
      return r;
    },
    utm(month) {
      const r = db.prepare(`SELECT utm_clp FROM utm_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`).get(`${month}-01`) as
        | { utm_clp: number }
        | undefined;
      if (!r) throw new Error(`demo: no UTM for ${month}`);
      return r.utm_clp;
    },
    close(ticker, day) {
      return onOrBefore(series(ticker), day, `${ticker} close`);
    },
    fundUnit(seriesKey, day) {
      let s = fundCache.get(seriesKey);
      if (!s) {
        const rows = db.prepare(`SELECT day, unit_value FROM fund_unit_daily WHERE series_key = ? ORDER BY day`).all(seriesKey) as {
          day: string;
          unit_value: number;
        }[];
        s = { d: rows.map((r) => r.day), c: rows.map((r) => r.unit_value) };
        fundCache.set(seriesKey, s);
      }
      return onOrBefore(s, day, `${seriesKey} value`);
    },
  };
}

/** What the real-market loader fetches for the hosted demo. */
/** The day the market holds a demo ticker's history from (its first use in the story). */
export function demoTickerFirstUse(ticker: string): Ymd {
  const row = DEMO_TICKERS.find((t) => t.ticker === ticker);
  if (!row) throw new Error(`demo market: ${ticker} is not a demo ticker`);
  return row.firstUse;
}

export function demoMarketSpec(today: Ymd = chileCalendarTodayYmd()): { fromMonth: Month; tickers: typeof DEMO_TICKERS; withAfp: boolean } {
  return { fromMonth: DEMO_PERSON.marketFromMonth(today), tickers: DEMO_TICKERS, withAfp: true };
}
