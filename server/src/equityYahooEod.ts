/**
 * Yahoo Finance chart v8 (unofficial). Daily EOD + intraday quote for MTM / marquee.
 * Requires a normal browser User-Agent or Yahoo returns 401.
 */

import { chileWallClockAt } from "./chileDate.js";
import { equityMarketKind } from "./equityQuote.js";
import { fetchOut } from "./httpOut.js";
import { isWeekendYmd } from "./marketHolidays.js";
import { nyseYmdFromUnix } from "./nyseSession.js";

export type EodCloseSeries = { dates: string[]; closes: number[] };

export type YahooLiveQuote = {
  /** Price in the symbol's exchange quote currency (see `equityQuoteCurrency`). */
  price: number;
  previous_close: number | null;
  /** Exchange session date for the quote (America/New_York for US listings). */
  session_ymd: string;
};

const CHART_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type YahooChartMeta = {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
  /** ISO code of the quote currency (`USD`, `CLP`, …); null on dead listings. */
  currency?: string | null;
  /** `EQUITY`, `ETF`, `INDEX`, `CRYPTOCURRENCY`, `FUTURE`, … */
  instrumentType?: string;
  exchangeTimezoneName?: string;
  fullExchangeName?: string;
  longName?: string;
  shortName?: string;
};

export type YahooChartResult = {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: (number | null)[] }> };
  /** Present when the query asks for `events=div`. */
  events?: { dividends?: Record<string, { amount?: number; date?: number }> };
};

/** One cash dividend per share, keyed by its ex-date, in the symbol's quote currency. */
export type YahooDividend = { ex_date: string; amount: number };

export type YahooDailyCloseParse = {
  series: EodCloseSeries;
  /** Last trade date in the parsed daily series (null if empty). */
  yahooLatestDate: string | null;
};

export type YahooNyseEodFetch = {
  series: EodCloseSeries;
  dividends: YahooDividend[];
  yahooLatestDate: string | null;
  dueSessionYmd: string;
  usedMetaClose: boolean;
  stillMissingDueSession: boolean;
};

type YahooChartJson = {
  chart?: {
    result?: YahooChartResult[];
    error?: { description?: string };
  };
};

async function fetchYahooChart(symbol: string, query: string): Promise<YahooChartResult> {
  const sym = encodeURIComponent(symbol);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?${query}`;
  const res = await fetchOut(`yahoo:${symbol}`, url, {
    headers: { "User-Agent": CHART_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Yahoo chart HTTP ${res.status} for ${symbol}`);
  }
  const j = (await res.json()) as YahooChartJson;
  const err = j.chart?.error?.description;
  if (err) throw new Error(`Yahoo chart error (${symbol}): ${err}`);
  const result = j.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart empty result for ${symbol}`);
  return result;
}

/** The chart `meta` alone: what Yahoo says the symbol is, and its current quote. */
export async function fetchYahooChartMeta(symbol: string): Promise<YahooChartMeta> {
  return (await fetchYahooChart(symbol, "interval=1d&range=5d")).meta ?? {};
}

/** Intraday / regular-hours quote from chart `meta` (same API as EOD history). */
export async function fetchYahooLiveQuote(symbol: string): Promise<YahooLiveQuote> {
  const result = await fetchYahooChart(symbol, "interval=1d&range=1d");
  const meta = result.meta;
  const price = meta?.regularMarketPrice;
  if (price == null || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo live price missing for ${symbol}`);
  }
  const prevRaw = meta?.chartPreviousClose ?? meta?.previousClose;
  const previous_close =
    prevRaw != null && Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : null;
  const rt = meta?.regularMarketTime;
  const session_ymd =
    rt != null && Number.isFinite(rt)
      ? yahooBarYmdFromUnix(symbol, rt)
      : yahooBarYmdFromUnix(symbol, Math.floor(Date.now() / 1000));
  return { price, previous_close, session_ymd };
}

/** Unix `period1` / `period2` for Yahoo chart (seconds), padded around [firstMk, lastMk]. */
export function yahooChartPeriodSeconds(firstMk: string, lastMk: string): { period1: number; period2: number } {
  const [y1, m1] = firstMk.split("-").map(Number);
  const [y2, m2] = lastMk.split("-").map(Number);
  const p1 = Math.floor((Date.UTC(y1, m1 - 1, 1) - 14 * 864e5) / 1000);
  const lastEndUtc = Date.UTC(y2, m2, 0);
  const p2 = Math.floor((lastEndUtc + 5 * 864e5) / 1000);
  return { period1: p1, period2: p2 };
}

/**
 * Bar timestamp → exchange calendar day, explicit per market kind (crypto: UTC, Santiago: Chile,
 * NYSE and forex `=X` pairs: New York — a CLP=X print at 17:00 NY on D labels D, which is the
 * fx-day convention `forexDay.ts` builds on).
 */
export function yahooBarYmdFromUnix(symbol: string, sec: number): string {
  const kind = equityMarketKind(symbol);
  if (kind === "crypto24") return new Date(sec * 1000).toISOString().slice(0, 10);
  if (kind === "santiago") return chileWallClockAt(new Date(sec * 1000)).ymd;
  return nyseYmdFromUnix(sec);
}

/**
 * Parse daily OHLC series from a Yahoo chart result (drops bars with null close). A symbol on
 * the NYSE calendar never has a weekend bar: an instrument that trades nearly around the clock
 * (the ICE dollar index `DX-Y.NYB`) opens Sunday evening, and the in-progress quote Yahoo
 * appends then is dated Sunday — its own Sunday bars carry no close.
 */
export function parseYahooDailyCloseSeries(symbol: string, result: YahooChartResult): YahooDailyCloseParse {
  const ts = result.timestamp;
  const close = result.indicators?.quote?.[0]?.close;
  if (!ts?.length || !close || close.length !== ts.length) {
    throw new Error(`Yahoo chart missing series for ${symbol}`);
  }
  const dates: string[] = [];
  const closes: number[] = [];
  const nyseCalendar = equityMarketKind(symbol) === "nyse";
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !Number.isFinite(c)) continue;
    const ymd = yahooBarYmdFromUnix(symbol, ts[i]!);
    if (nyseCalendar && isWeekendYmd(ymd)) continue;
    dates.push(ymd);
    closes.push(c);
  }
  if (dates.length === 0) throw new Error(`Yahoo chart empty closes for ${symbol}`);
  const yahooLatestDate = dates[dates.length - 1] ?? null;
  return { series: { dates, closes }, yahooLatestDate };
}

/** Dividends from a chart result fetched with `events=div` (ascending by ex-date). */
export function parseYahooDividends(symbol: string, result: YahooChartResult): YahooDividend[] {
  const raw = result.events?.dividends;
  if (raw == null) return [];
  const out: YahooDividend[] = [];
  for (const [key, d] of Object.entries(raw)) {
    const sec = d.date ?? Number(key);
    const amount = d.amount;
    if (!Number.isFinite(sec) || amount == null || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Yahoo dividend for ${symbol}: unreadable entry ${JSON.stringify({ key, d })}`);
    }
    out.push({ ex_date: yahooBarYmdFromUnix(symbol, sec), amount });
  }
  out.sort((a, b) => a.ex_date.localeCompare(b.ex_date));
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.ex_date === out[i - 1]!.ex_date) {
      throw new Error(`Yahoo dividends for ${symbol}: two on ${out[i]!.ex_date}`);
    }
  }
  return out;
}

/** Daily closes and dividends over [period1, period2] in one chart request. */
export async function fetchYahooDailyClosesAndDividends(
  symbol: string,
  period1Sec: number,
  period2Sec: number
): Promise<{ series: EodCloseSeries; dividends: YahooDividend[] }> {
  const result = await fetchYahooChart(
    symbol,
    `interval=1d&events=div&period1=${period1Sec}&period2=${period2Sec}`
  );
  return {
    series: parseYahooDailyCloseSeries(symbol, result).series,
    dividends: parseYahooDividends(symbol, result),
  };
}

/**
 * When Yahoo's daily series omits today's close (null bar after the bell), use chart `meta.regularMarketPrice`
 * for the due NYSE session when `regularMarketTime` matches that session.
 */
export function enrichNyseEodSeriesFromMeta(
  series: EodCloseSeries,
  meta: YahooChartMeta | undefined,
  dueSessionYmd: string
): { series: EodCloseSeries; usedMetaClose: boolean } {
  const latest = series.dates[series.dates.length - 1];
  if (latest != null && latest >= dueSessionYmd) {
    return { series, usedMetaClose: false };
  }
  const price = meta?.regularMarketPrice;
  if (price == null || !Number.isFinite(price) || price <= 0) {
    return { series, usedMetaClose: false };
  }
  const rt = meta?.regularMarketTime;
  const sessionYmd =
    rt != null && Number.isFinite(rt) ? nyseYmdFromUnix(rt) : null;
  if (sessionYmd !== dueSessionYmd) {
    return { series, usedMetaClose: false };
  }
  return {
    series: {
      dates: [...series.dates, dueSessionYmd],
      closes: [...series.closes, price],
    },
    usedMetaClose: true,
  };
}

export async function fetchYahooDailyCloses(
  symbol: string,
  period1Sec: number,
  period2Sec: number
): Promise<EodCloseSeries> {
  const result = await fetchYahooChart(
    symbol,
    `interval=1d&period1=${period1Sec}&period2=${period2Sec}`
  );
  return parseYahooDailyCloseSeries(symbol, result).series;
}

/** NYSE EOD sync: one chart fetch, meta fallback when the due session bar has no daily close yet. */
export async function fetchYahooNyseEodForSync(
  symbol: string,
  opts: { dueSessionYmd: string; days?: number; now?: Date }
): Promise<YahooNyseEodFetch> {
  const days = opts.days ?? 21;
  const now = opts.now ?? new Date();
  const period2 = Math.floor(now.getTime() / 1000);
  const period1 = period2 - days * 86400;
  const result = await fetchYahooChart(
    symbol,
    `interval=1d&events=div&period1=${period1}&period2=${period2}`
  );
  const parsed = parseYahooDailyCloseSeries(symbol, result);
  const dividends = parseYahooDividends(symbol, result);
  const enriched = enrichNyseEodSeriesFromMeta(parsed.series, result.meta, opts.dueSessionYmd);
  const yahooLatestDate = enriched.series.dates[enriched.series.dates.length - 1] ?? null;
  const stillMissingDueSession =
    yahooLatestDate == null || yahooLatestDate < opts.dueSessionYmd;
  return {
    series: enriched.series,
    dividends,
    yahooLatestDate,
    dueSessionYmd: opts.dueSessionYmd,
    usedMetaClose: enriched.usedMetaClose,
    stillMissingDueSession,
  };
}

/** Recent daily bars (for EOD sync). `days` calendar lookback from today. */
export async function fetchYahooRecentDailyCloses(symbol: string, days = 14): Promise<EodCloseSeries> {
  return (await fetchYahooRecentDailyClosesWithMeta(symbol, days)).series;
}

/** Recent daily bars plus the chart `meta` (the current quote and its time) — one request. */
export async function fetchYahooRecentDailyClosesWithMeta(
  symbol: string,
  days = 14
): Promise<{ series: EodCloseSeries; meta: YahooChartMeta | undefined }> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - days * 86400;
  const result = await fetchYahooChart(symbol, `interval=1d&period1=${period1}&period2=${period2}`);
  return { series: parseYahooDailyCloseSeries(symbol, result).series, meta: result.meta };
}

