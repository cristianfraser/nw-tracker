/**
 * The Yahoo Finance adapter: symbol search, the facts of a symbol (from its chart `meta`), and the
 * check an EOD series' printed currency passes. The only code that reads a Yahoo symbol's shape
 * (through `yahooSymbol.ts`) and maps Yahoo's time zones and exchange names onto the app's markets.
 *
 * Search and describe are the only Yahoo calls on an HTTP request path, and both are a person's own
 * action (typing in an add box, pressing add); display reads stay DB-only.
 */
import {
  fetchYahooChartMeta,
  fetchYahooDailyCloses,
  fetchYahooLiveQuote,
  fetchYahooRecentDailyCloses,
  type YahooChartMeta,
} from "../equityYahooEod.js";
import { BROWSER_USER_AGENT, fetchOutboundText } from "../outboundFetch.js";
import {
  requireMarketSymbol,
  type InstrumentFacts,
  type MarketQuoteCurrency,
  type MarketSymbolKind,
} from "../marketSymbols.js";
import { isCurrencyCode } from "../rates.js";
import type { PriceProvider, ProviderSymbolSearchResult } from "./types.js";
import { yahooDisplaySymbol } from "./yahooSymbol.js";

export { yahooDisplaySymbol } from "./yahooSymbol.js";

type YahooSearchJson = {
  quotes?: Array<{
    symbol?: string;
    shortname?: string;
    longname?: string;
    exchDisp?: string;
    typeDisp?: string;
    quoteType?: string;
    isYahooFinance?: boolean;
  }>;
};

export async function searchYahooSymbols(query: string): Promise<ProviderSymbolSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
  const res = await fetchOutboundText({ label: "yahoo:search", url, userAgent: BROWSER_USER_AGENT, accept: "application/json" });
  if (!res.ok) throw new Error(`Yahoo search HTTP ${res.status}`);
  const json = JSON.parse(res.text) as YahooSearchJson;
  return (json.quotes ?? [])
    // Option contracts expire and are not something to watch over years.
    .filter((r) => r.isYahooFinance !== false && r.quoteType !== "OPTION" && typeof r.symbol === "string" && r.symbol.trim())
    .map((r) => ({
      symbol: r.symbol!.trim().toUpperCase(),
      name: r.longname?.trim() || r.shortname?.trim() || null,
      exchange: r.exchDisp?.trim() || null,
      type: r.typeDisp?.trim() || null,
    }));
}

/** Yahoo's `exchangeTimezoneName` → the market whose calendar the app values on. */
const YAHOO_TIMEZONE_MARKET: Readonly<Record<string, MarketSymbolKind>> = {
  "America/New_York": "nyse",
  "America/Santiago": "santiago",
  "Europe/London": "london",
};

/**
 * What a chart `meta` says about `symbol`, or why the app cannot value it. The app values on four
 * calendars (NYSE, Bolsa de Santiago, the London Stock Exchange, crypto around the clock) and in
 * any currency the `currencies` table holds, so a listing on another exchange, or quoted in a
 * currency the app has no rates for, is refused rather than valued on the wrong calendar or at no
 * rate. Pence (`GBp`, how the LSE quotes many lines) is a hundredth of a pound, not a currency, and
 * is refused by name. An index has no currency (null).
 */
export function classifyYahooSymbol(symbol: string, meta: YahooChartMeta): InstrumentFacts {
  const price = meta.regularMarketPrice;
  if (price == null || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo has no price for ${symbol}`);
  }
  const type = meta.instrumentType ?? null;

  const tz = meta.exchangeTimezoneName ?? "";
  const marketKind: MarketSymbolKind | undefined = type === "CRYPTOCURRENCY" ? "crypto24" : YAHOO_TIMEZONE_MARKET[tz];
  if (marketKind == null) {
    throw new Error(
      `${symbol} trades on ${meta.fullExchangeName ?? "an exchange"} (${tz || "unknown time zone"}); only US, Santiago, London and crypto markets are supported`
    );
  }

  let quoteCurrency: MarketQuoteCurrency;
  if (type === "INDEX") quoteCurrency = null;
  else {
    const printed = meta.currency ?? null;
    if (printed == null) throw new Error(`${symbol} is quoted in no currency (and is not an index)`);
    if (printed === "GBp" || printed === "GBX") {
      throw new Error(`${symbol} is quoted in ${printed} (pence), not a currency; hold a line quoted in a currency the app loads (CSPX.L, VWRA.L in USD)`);
    }
    const code = printed.toLowerCase();
    if (!/^[a-z]{3}$/.test(code) || code === "uf" || !isCurrencyCode(code)) {
      throw new Error(`${symbol} is quoted in ${printed}, which is not in the currencies table; the app has no rates for it`);
    }
    quoteCurrency = code;
  }

  return {
    quote_currency: quoteCurrency,
    market_kind: marketKind,
    exchange: meta.fullExchangeName ?? null,
    name: meta.longName?.trim() || meta.shortName?.trim() || null,
    instrument_type: type,
    display_symbol: yahooDisplaySymbol(symbol),
  };
}

export async function describeYahooSymbol(symbol: string): Promise<InstrumentFacts> {
  let meta: YahooChartMeta;
  try {
    meta = await fetchYahooChartMeta(symbol);
  } catch (e) {
    throw new Error(`Yahoo does not know ${symbol} (${e instanceof Error ? e.message : String(e)})`);
  }
  return classifyYahooSymbol(symbol, meta);
}

/**
 * A Yahoo series' printed currency must be the registered one before its bars are stored: the LSE
 * also quotes in pence and euros, so a London line's currency is checked on every EOD write.
 */
export function checkYahooSeriesCurrency(ticker: string, meta: { currency?: string | null } | undefined): void {
  const expected = requireMarketSymbol(ticker).quote_currency;
  if (expected == null) throw new Error(`${ticker} is registered as an index; its series has no currency to check`);
  const printed = meta?.currency ?? null;
  if (printed == null) throw new Error(`Yahoo prints no currency for ${ticker}; expected ${expected.toUpperCase()}`);
  if (printed.toLowerCase() !== expected) {
    throw new Error(
      `${ticker} is quoted in ${printed} on Yahoo, the app values it in ${expected.toUpperCase()}: register its real currency in market_symbols, or hold the ${expected.toUpperCase()} line`
    );
  }
}

export const yahooPriceProvider: PriceProvider = {
  id: "yahoo",
  describeSymbol: describeYahooSymbol,
  search: searchYahooSymbols,
  dailyCloses: (symbol, opts) =>
    opts?.recentDays != null
      ? fetchYahooRecentDailyCloses(symbol, opts.recentDays)
      : fetchYahooDailyCloses(symbol, 0, Math.floor(Date.now() / 1000)),
  liveQuote: fetchYahooLiveQuote,
};
