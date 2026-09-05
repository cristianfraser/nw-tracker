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

/** Recent daily bars (`days` calendar lookback, max 365 on public API). */
export async function fetchCoinGeckoRecentDailyCloses(ticker: string, days = 30): Promise<EodCloseSeries> {
  const coinId = coingeckoIdForCryptoTicker(ticker);
  const clamped = Math.min(Math.max(days, 1), 365);
  const j = await fetchCoinGeckoMarketChart(coinId, `vs_currency=usd&days=${clamped}`);
  return aggregateCoinGeckoPricesToUtcDaily(j.prices!);
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
