/**
 * CoinGecko daily USD closes for crypto EOD (`equity_daily`).
 * Public/demo API: historical chart limited to the past 365 days.
 */

import { fetchOut } from "./httpOut.js";
import type { EodCloseSeries } from "./equityYahooEod.js";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/** Yahoo-style tickers stored in `equity_daily.ticker`. */
export const CRYPTO_TICKER_COINGECKO_ID: Readonly<Record<string, string>> = {
  "BTC-USD": "bitcoin",
  "ETH-USD": "ethereum",
};

export const COINGECKO_CRYPTO_TICKERS = Object.keys(CRYPTO_TICKER_COINGECKO_ID) as Array<
  keyof typeof CRYPTO_TICKER_COINGECKO_ID
>;

type CoinGeckoMarketChart = {
  prices?: Array<[number, number]>;
  error?: string;
  status?: { error_code?: number; error_message?: string };
};

function coingeckoApiHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  if (!key) return { Accept: "application/json" };
  return { Accept: "application/json", "x-cg-demo-api-key": key };
}

export function coingeckoIdForCryptoTicker(ticker: string): string {
  const id = CRYPTO_TICKER_COINGECKO_ID[ticker];
  if (!id) throw new Error(`No CoinGecko id for crypto ticker ${ticker}`);
  return id;
}

/** Group CoinGecko `[ms, price]` samples into UTC calendar-day closes (last sample per day). */
export function aggregateCoinGeckoPricesToUtcDaily(prices: ReadonlyArray<readonly [number, number]>): EodCloseSeries {
  const byDay = new Map<string, number>();
  for (const [ms, price] of prices) {
    if (!Number.isFinite(ms) || !Number.isFinite(price) || price <= 0) continue;
    const ymd = new Date(ms).toISOString().slice(0, 10);
    byDay.set(ymd, price);
  }
  const dates = [...byDay.keys()].sort();
  const closes = dates.map((d) => byDay.get(d)!);
  if (dates.length === 0) throw new Error("CoinGecko chart empty closes");
  return { dates, closes };
}

function parseCoinGeckoChartError(j: CoinGeckoMarketChart, label: string): string | null {
  const msg = j.status?.error_message ?? j.error;
  return msg ? `CoinGecko chart error (${label}): ${msg}` : null;
}

async function fetchCoinGeckoMarketChart(coinId: string, query: string): Promise<CoinGeckoMarketChart> {
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/market_chart?${query}`;
  const res = await fetchOut(`coingecko:${coinId}`, url, { headers: coingeckoApiHeaders() });
  if (!res.ok) {
    throw new Error(`CoinGecko chart HTTP ${res.status} for ${coinId}`);
  }
  const j = (await res.json()) as CoinGeckoMarketChart;
  const err = parseCoinGeckoChartError(j, coinId);
  if (err) throw new Error(err);
  if (!j.prices?.length) throw new Error(`CoinGecko chart missing prices for ${coinId}`);
  return j;
}

async function fetchCoinGeckoMarketChartRange(
  coinId: string,
  fromSec: number,
  toSec: number
): Promise<CoinGeckoMarketChart> {
  const url =
    `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/market_chart/range` +
    `?vs_currency=usd&from=${fromSec}&to=${toSec}`;
  const res = await fetchOut(`coingecko:${coinId}`, url, { headers: coingeckoApiHeaders() });
  if (!res.ok) {
    throw new Error(`CoinGecko chart range HTTP ${res.status} for ${coinId}`);
  }
  const j = (await res.json()) as CoinGeckoMarketChart;
  const err = parseCoinGeckoChartError(j, coinId);
  if (err) throw new Error(err);
  if (!j.prices?.length) throw new Error(`CoinGecko chart range missing prices for ${coinId}`);
  return j;
}

/** Recent daily bars (`days` calendar lookback, max 365 on public API). */
export async function fetchCoinGeckoRecentDailyCloses(ticker: string, days = 30): Promise<EodCloseSeries> {
  const coinId = coingeckoIdForCryptoTicker(ticker);
  const clamped = Math.min(Math.max(days, 1), 365);
  const j = await fetchCoinGeckoMarketChart(coinId, `vs_currency=usd&days=${clamped}`);
  return aggregateCoinGeckoPricesToUtcDaily(j.prices!);
}

/** Daily closes between `startYmd` and `endYmd` inclusive (public API: within past 365 days). */
export async function fetchCoinGeckoDailyClosesBetween(
  ticker: string,
  startYmd: string,
  endYmd: string
): Promise<EodCloseSeries> {
  const coinId = coingeckoIdForCryptoTicker(ticker);
  const [y1, m1, d1] = startYmd.split("-").map(Number);
  const [y2, m2, d2] = endYmd.split("-").map(Number);
  const fromSec = Math.floor(Date.UTC(y1!, m1! - 1, d1!) / 1000);
  const toSec = Math.floor((Date.UTC(y2!, m2! - 1, d2!) + 864e5 - 1) / 1000);
  const spanDays = Math.ceil((toSec - fromSec) / 86400);
  const j =
    spanDays <= 90
      ? await fetchCoinGeckoMarketChartRange(coinId, fromSec, toSec)
      : await fetchCoinGeckoMarketChart(coinId, `vs_currency=usd&days=${Math.min(spanDays + 2, 365)}`);
  const series = aggregateCoinGeckoPricesToUtcDaily(j.prices!);
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i]!;
    if (d < startYmd || d > endYmd) continue;
    dates.push(d);
    closes.push(series.closes[i]!);
  }
  if (dates.length === 0) {
    throw new Error(`CoinGecko chart empty closes for ${ticker} between ${startYmd} and ${endYmd}`);
  }
  return { dates, closes };
}

export function mergeEodCloseSeriesPreferPrimary(
  primary: EodCloseSeries,
  fallback: EodCloseSeries
): EodCloseSeries {
  const byDate = new Map<string, number>();
  for (let i = 0; i < fallback.dates.length; i++) {
    byDate.set(fallback.dates[i]!, fallback.closes[i]!);
  }
  for (let i = 0; i < primary.dates.length; i++) {
    byDate.set(primary.dates[i]!, primary.closes[i]!);
  }
  const dates = [...byDate.keys()].sort();
  return { dates, closes: dates.map((d) => byDate.get(d)!) };
}

/** Full public-API history (365 calendar days). */
export async function fetchCoinGeckoMaxDailyCloses(ticker: string): Promise<EodCloseSeries> {
  return fetchCoinGeckoRecentDailyCloses(ticker, 365);
}
