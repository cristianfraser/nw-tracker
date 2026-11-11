/**
 * The CoinGecko adapter: daily USD closes of the coins it knows, stored under their Yahoo-style
 * ticker (`BTC-USD`). The fetching stays in `equityCoinGeckoEod.ts`; this declares it. CoinGecko
 * serves no live quote the app reads (Yahoo's stream does) and no search.
 */
import {
  CRYPTO_TICKER_COINGECKO_ID,
  fetchCoinGeckoMaxDailyCloses,
  fetchCoinGeckoRecentDailyCloses,
} from "../equityCoinGeckoEod.js";
import type { InstrumentFacts } from "../marketSymbols.js";
import type { PriceProvider } from "./types.js";

const COIN_NAMES: Readonly<Record<string, string>> = { "BTC-USD": "Bitcoin USD", "ETH-USD": "Ethereum USD" };

/** A coin CoinGecko prices: a dollar price on the around-the-clock calendar, no exchange. */
export async function describeCoinGeckoSymbol(symbol: string): Promise<InstrumentFacts> {
  const ticker = symbol.trim().toUpperCase();
  if (CRYPTO_TICKER_COINGECKO_ID[ticker] == null) {
    throw new Error(`CoinGecko does not price ${symbol} (known: ${Object.keys(CRYPTO_TICKER_COINGECKO_ID).join(", ")})`);
  }
  return {
    quote_currency: "usd",
    market_kind: "crypto24",
    exchange: null,
    name: COIN_NAMES[ticker] ?? null,
    instrument_type: "CRYPTOCURRENCY",
    display_symbol: ticker,
  };
}

export const coingeckoPriceProvider: PriceProvider = {
  id: "coingecko",
  describeSymbol: describeCoinGeckoSymbol,
  dailyCloses: (symbol, opts) =>
    opts?.recentDays != null ? fetchCoinGeckoRecentDailyCloses(symbol, opts.recentDays) : fetchCoinGeckoMaxDailyCloses(symbol),
};
