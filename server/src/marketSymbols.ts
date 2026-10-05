import { db } from "./db.js";

/**
 * What Yahoo said about a watchlist symbol when it was added (`market_symbols`, migration 210):
 * the currency its price is quoted in and the market whose calendar it trades on. `none` is an
 * index level — points, not money — which is never converted between CLP and USD. A ticker
 * with no row keeps the suffix rule in `equityQuote.ts`.
 *
 * Read on hot paths (every equity mark asks for its quote currency), so the rows live in a
 * process cache: written through by {@link registerMarketSymbol} and reloaded by
 * {@link reloadMarketSymbols} on the live-quotes tick and each watchlist read, which picks up
 * a symbol another process added.
 */
export type MarketQuoteCurrency = "usd" | "clp" | "none";
export type MarketSymbolKind = "nyse" | "santiago" | "crypto24";

export type MarketSymbolRow = {
  ticker: string;
  quote_currency: MarketQuoteCurrency;
  market_kind: MarketSymbolKind;
  name: string | null;
  exchange: string | null;
  instrument_type: string | null;
  verified_at: string;
};

const stmtAll = db.prepare(
  `SELECT ticker, quote_currency, market_kind, name, exchange, instrument_type, verified_at
   FROM market_symbols`
);
const stmtUpsert = db.prepare(
  `INSERT INTO market_symbols (ticker, quote_currency, market_kind, name, exchange, instrument_type, verified_at)
   VALUES (@ticker, @quote_currency, @market_kind, @name, @exchange, @instrument_type, @verified_at)
   ON CONFLICT(ticker) DO UPDATE SET
     quote_currency = excluded.quote_currency, market_kind = excluded.market_kind, name = excluded.name,
     exchange = excluded.exchange, instrument_type = excluded.instrument_type, verified_at = excluded.verified_at`
);

let cache: Map<string, MarketSymbolRow> | null = null;

export function reloadMarketSymbols(): void {
  cache = new Map((stmtAll.all() as MarketSymbolRow[]).map((r) => [r.ticker, r]));
}

export function marketSymbol(ticker: string): MarketSymbolRow | null {
  if (cache == null) reloadMarketSymbols();
  return cache!.get(ticker.toUpperCase()) ?? null;
}

export function registerMarketSymbol(row: MarketSymbolRow): void {
  const normalized = { ...row, ticker: row.ticker.toUpperCase() };
  stmtUpsert.run(normalized);
  if (cache == null) reloadMarketSymbols();
  else cache.set(normalized.ticker, normalized);
}

const stmtUpsertError = db.prepare(
  `INSERT INTO market_symbol_fetch_errors (ticker, stage, message, failed_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(ticker, stage) DO UPDATE SET message = excluded.message, failed_at = excluded.failed_at`
);
const stmtClearError = db.prepare(`DELETE FROM market_symbol_fetch_errors WHERE ticker = ? AND stage = ?`);
const stmtErrorsFor = db.prepare(
  `SELECT stage, message, failed_at FROM market_symbol_fetch_errors WHERE ticker = ? ORDER BY failed_at DESC`
);

export type MarketSymbolFetchStage = "live" | "history";
export type MarketSymbolFetchError = { stage: MarketSymbolFetchStage; message: string; failed_at: string };

export function recordMarketSymbolFetchError(
  ticker: string,
  stage: MarketSymbolFetchStage,
  message: string,
  at: Date = new Date()
): void {
  stmtUpsertError.run(ticker.toUpperCase(), stage, message.slice(0, 300), at.toISOString());
}

export function clearMarketSymbolFetchError(ticker: string, stage: MarketSymbolFetchStage): void {
  stmtClearError.run(ticker.toUpperCase(), stage);
}

/** The latest fetch failure for `ticker` (any stage), or null when its last fetches succeeded. */
export function latestMarketSymbolFetchError(ticker: string): MarketSymbolFetchError | null {
  const rows = stmtErrorsFor.all(ticker.toUpperCase()) as MarketSymbolFetchError[];
  return rows[0] ?? null;
}
