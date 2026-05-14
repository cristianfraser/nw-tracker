/**
 * Daily closes from Yahoo Finance chart v8 (unofficial). Not for trading; import-time MTM only.
 * Requires a normal browser User-Agent or Yahoo returns 401.
 */

export type EodCloseSeries = { dates: string[]; closes: number[] };

const CHART_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type YahooChartJson = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[] }> };
    }>;
    error?: { description?: string };
  };
};

/** Unix `period1` / `period2` for Yahoo chart (seconds), padded around [firstMk, lastMk]. */
export function yahooChartPeriodSeconds(firstMk: string, lastMk: string): { period1: number; period2: number } {
  const [y1, m1] = firstMk.split("-").map(Number);
  const [y2, m2] = lastMk.split("-").map(Number);
  const p1 = Math.floor((Date.UTC(y1, m1 - 1, 1) - 14 * 864e5) / 1000);
  const lastEndUtc = Date.UTC(y2, m2, 0);
  const p2 = Math.floor((lastEndUtc + 5 * 864e5) / 1000);
  return { period1: p1, period2: p2 };
}

export async function fetchYahooDailyCloses(
  symbol: string,
  period1Sec: number,
  period2Sec: number
): Promise<EodCloseSeries> {
  const sym = encodeURIComponent(symbol);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${period1Sec}&period2=${period2Sec}`;
  const res = await fetch(url, {
    headers: { "User-Agent": CHART_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Yahoo chart HTTP ${res.status} for ${symbol}`);
  }
  const j = (await res.json()) as YahooChartJson;
  const err = j.chart?.error?.description;
  if (err) throw new Error(`Yahoo chart error (${symbol}): ${err}`);
  const result = j.chart?.result?.[0];
  const ts = result?.timestamp;
  const close = result?.indicators?.quote?.[0]?.close;
  if (!ts?.length || !close || close.length !== ts.length) {
    throw new Error(`Yahoo chart missing series for ${symbol}`);
  }
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !Number.isFinite(c)) continue;
    dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    closes.push(c);
  }
  if (dates.length === 0) throw new Error(`Yahoo chart empty closes for ${symbol}`);
  return { dates, closes };
}

/** Last daily close on or before `ymd` (YYYY-MM-DD). `series.dates` sorted ascending. */
export function lastCloseOnOrBefore(series: EodCloseSeries, ymd: string): number | null {
  const { dates, closes } = series;
  if (dates.length === 0) return null;
  if (ymd < dates[0]) return null;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (dates[mid] <= ymd) lo = mid;
    else hi = mid - 1;
  }
  return closes[lo];
}

/** Mark-to-market CLP: shares × last USD close ≤ month-end × CLP/USD for that month (sheet FX). */
export function equityMtmValueClp(
  units: number,
  series: EodCloseSeries | null,
  positionEndYmd: string,
  clpPerUsd: number | null | undefined
): number | null {
  if (!series || units <= 0) return null;
  if (clpPerUsd == null || !Number.isFinite(clpPerUsd) || clpPerUsd <= 0) return null;
  const usd = lastCloseOnOrBefore(series, positionEndYmd);
  if (usd == null) return null;
  const v = units * usd * clpPerUsd;
  return Number.isFinite(v) ? v : null;
}
