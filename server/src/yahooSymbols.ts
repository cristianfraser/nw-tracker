/**
 * Yahoo symbol search and the check a watchlist symbol passes before it is added.
 *
 * These are the only Yahoo calls on an HTTP request path, and both are a user's own action
 * (typing in the watchlist's add box, pressing add) — display reads stay DB-only.
 */
import { fetchYahooChartMeta, type YahooChartMeta } from "./equityYahooEod.js";
import { fetchOut } from "./httpOut.js";
import type { MarketQuoteCurrency, MarketSymbolKind, MarketSymbolRow } from "./marketSymbols.js";

const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type YahooSymbolSearchResult = {
  symbol: string;
  name: string | null;
  exchange: string | null;
  /** Yahoo's display type: `Equity`, `ETF`, `Index`, `Cryptocurrency`, … */
  type: string | null;
};

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

export async function searchYahooSymbols(query: string): Promise<YahooSymbolSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
  const res = await fetchOut("yahoo:search", url, {
    headers: { "User-Agent": SEARCH_UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Yahoo search HTTP ${res.status}`);
  const json = (await res.json()) as YahooSearchJson;
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

/**
 * What a chart `meta` says about `symbol`, or why it cannot go on the watchlist. The app
 * values on three calendars (NYSE, Bolsa de Santiago, crypto around the clock) and in two
 * currencies, so a listing on another exchange or quoted in another currency is refused
 * rather than valued on the wrong calendar or at the wrong rate. An index has no currency.
 */
export function classifyYahooSymbol(
  symbol: string,
  meta: YahooChartMeta,
  now: Date = new Date()
): MarketSymbolRow {
  const price = meta.regularMarketPrice;
  if (price == null || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo has no price for ${symbol}`);
  }
  const type = meta.instrumentType ?? null;

  let marketKind: MarketSymbolKind;
  const tz = meta.exchangeTimezoneName ?? "";
  if (type === "CRYPTOCURRENCY") marketKind = "crypto24";
  else if (tz === "America/Santiago") marketKind = "santiago";
  else if (tz === "America/New_York") marketKind = "nyse";
  else {
    throw new Error(
      `${symbol} trades on ${meta.fullExchangeName ?? "an exchange"} (${tz || "unknown time zone"}); only US, Santiago and crypto markets are supported`
    );
  }

  let quoteCurrency: MarketQuoteCurrency;
  if (type === "INDEX") quoteCurrency = "none";
  else if (meta.currency === "USD") quoteCurrency = "usd";
  else if (meta.currency === "CLP") quoteCurrency = "clp";
  else {
    throw new Error(
      `${symbol} is quoted in ${meta.currency ?? "no currency"}; only USD and CLP prices (or an index) are supported`
    );
  }

  return {
    ticker: symbol.toUpperCase(),
    quote_currency: quoteCurrency,
    market_kind: marketKind,
    name: meta.longName?.trim() || meta.shortName?.trim() || null,
    exchange: meta.fullExchangeName ?? null,
    instrument_type: type,
    verified_at: now.toISOString(),
  };
}

export async function verifyYahooSymbol(symbol: string): Promise<MarketSymbolRow> {
  let meta: YahooChartMeta;
  try {
    meta = await fetchYahooChartMeta(symbol);
  } catch (e) {
    throw new Error(`Yahoo does not know ${symbol} (${e instanceof Error ? e.message : String(e)})`);
  }
  return classifyYahooSymbol(symbol, meta);
}
