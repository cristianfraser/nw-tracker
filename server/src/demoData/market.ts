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
import { isNyseTradingDay, isWeekendYmd } from "../marketHolidays.js";
import { upsertSpAfpFundUnits, type SpAfpFundUnitRow } from "../spAfpFundUnits.js";
import { stream } from "./rng.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { addDays, addMonths, BTC_TICKER, DEMO_PERSON, type Month, type Person, type Ymd } from "./person.js";

/** Every ticker the person holds, with the first day the story needs its price. */
export const DEMO_TICKERS: { ticker: string; firstUse: Ymd }[] = [
  { ticker: "SPY", firstUse: "2018-05-01" },
  { ticker: "AAPL", firstUse: "2019-03-01" },
  { ticker: "AMD", firstUse: "2019-07-01" },
  { ticker: "MSFT", firstUse: "2020-04-01" },
  { ticker: "ZM", firstUse: "2020-10-01" },
  { ticker: "NVDA", firstUse: "2021-03-01" },
  { ticker: "INTC", firstUse: "2021-04-01" },
  { ticker: "OILK", firstUse: "2026-05-01" },
  { ticker: "LNG", firstUse: "2026-05-01" },
  { ticker: BTC_TICKER, firstUse: "2018-06-01" },
];

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
  const insEq = db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
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
      const crypto = ticker.endsWith("-USD");
      for (let d = start < anchors[0]![0] ? anchors[0]![0] : start; d <= lastDay; d = addDays(d, 1)) {
        if (!crypto && !isNyseTradingDay(d)) continue;
        const sd = crypto ? 0.02 : 0.008;
        insEq.run(ticker, d, Math.round(anchorValue(anchors, d) * (1 + noise.gauss() * sd) * 100) / 100);
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
    rows.push({ afp: "uno", fund: "A", day: d, unit_value_clp: Math.round(v * 100) / 100, provisional: false });
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
        const rows = db.prepare(`SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? ORDER BY day`).all(seriesKey) as {
          day: string;
          unit_value_clp: number;
        }[];
        s = { d: rows.map((r) => r.day), c: rows.map((r) => r.unit_value_clp) };
        fundCache.set(seriesKey, s);
      }
      return onOrBefore(s, day, `${seriesKey} value`);
    },
  };
}

/** What the real-market loader fetches for the hosted demo. */
export function demoMarketSpec(today: Ymd = chileCalendarTodayYmd()): { fromMonth: Month; tickers: typeof DEMO_TICKERS; withAfp: boolean } {
  return { fromMonth: DEMO_PERSON.marketFromMonth(today), tickers: DEMO_TICKERS, withAfp: true };
}
