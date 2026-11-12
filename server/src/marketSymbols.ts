import { db } from "./db.js";

/**
 * The instrument registry (`market_symbols`, migrations 210 / 303 / 305 / 315): the one source of an
 * instrument's facts — the currency its price is quoted in (any code `currencies` holds; null for an
 * index level: points, not money, never converted), the market whose calendar and sessions it trades on,
 * the exchange's ISO 10383 code, the symbol a position shows, and who stated them (a price provider,
 * or the demo generator's declaration). A reader never parses a ticker's spelling: an instrument
 * with no row throws ({@link requireMarketSymbol}).
 *
 * Read on hot paths (every equity mark asks for its quote currency), so the rows live in a process
 * cache: written through by {@link registerInstrument}, reloaded by {@link reloadMarketSymbols} on
 * the live-quotes tick and each watchlist read, and once more before a miss throws, which picks up
 * a symbol another process registered.
 */
/**
 * The currency an instrument's price is quoted in: a code of `currencies` (`usd`, `clp`, `eur`, …;
 * the column references it, migration 315), or null for an index level (points, not money). The
 * same null is stored in `equity_daily.currency` and `live_market_quotes.currency`.
 */
export type MarketQuoteCurrency = string | null;
export type MarketSymbolKind = "nyse" | "santiago" | "london" | "crypto24";

/** Who stated an instrument's facts: a price provider's adapter, or a declaration (the demo, a fixture). */
export type InstrumentSource = "yahoo" | "coingecko" | "bolsa_santiago" | "declared";

/** What a provider (or a declaration) states about an instrument. */
export type InstrumentFacts = {
  quote_currency: MarketQuoteCurrency;
  market_kind: MarketSymbolKind;
  /** The provider's own name for the exchange (provenance). */
  exchange: string | null;
  name: string | null;
  /** The provider's instrument type (`EQUITY`, `ETF`, `INDEX`, `CRYPTOCURRENCY`, …). */
  instrument_type: string | null;
  /** The symbol without a provider's exchange suffix (CSPX, CFIETFIPSA, SPY). */
  display_symbol: string;
  isin?: string | null;
};

export type MarketSymbolRow = {
  ticker: string;
  quote_currency: MarketQuoteCurrency;
  market_kind: MarketSymbolKind;
  isin: string | null;
  display_symbol: string;
  name: string | null;
  exchange: string | null;
  instrument_type: string | null;
  source: InstrumentSource;
  verified_at: string;
};

const COLUMNS = `ticker, quote_currency, market_kind, isin, display_symbol, name, exchange, instrument_type, source, verified_at`;
const stmtAll = db.prepare(`SELECT ${COLUMNS} FROM market_symbols`);
const stmtOne = db.prepare(`SELECT ${COLUMNS} FROM market_symbols WHERE ticker = ?`);
const stmtUpsert = db.prepare(
  `INSERT INTO market_symbols (${COLUMNS})
   VALUES (@ticker, @quote_currency, @market_kind, @isin, @display_symbol, @name, @exchange, @instrument_type, @source, @verified_at)
   ON CONFLICT(ticker) DO UPDATE SET
     quote_currency = excluded.quote_currency, market_kind = excluded.market_kind,
     isin = excluded.isin, display_symbol = excluded.display_symbol, name = excluded.name,
     exchange = excluded.exchange, instrument_type = excluded.instrument_type, source = excluded.source,
     verified_at = excluded.verified_at`
);
const stmtKnownCurrency = db.prepare(`SELECT 1 FROM currencies WHERE code = ?`);
const stmtStoredBarCurrencies = db.prepare(
  `SELECT currency, COUNT(*) AS n FROM equity_daily WHERE ticker = ? GROUP BY currency`
);

let cache: Map<string, MarketSymbolRow> | null = null;

/** A quote currency for a message: the code, or «index» for an index level (null). */
export function quoteCurrencyLabel(currency: MarketQuoteCurrency): string {
  return currency ?? "index";
}

export function reloadMarketSymbols(): void {
  cache = new Map((stmtAll.all() as MarketSymbolRow[]).map((r) => [r.ticker, r]));
}

/** The registered row, or null. Prefer {@link requireMarketSymbol} wherever the facts are needed. */
export function marketSymbol(ticker: string): MarketSymbolRow | null {
  if (cache == null) reloadMarketSymbols();
  return cache!.get(ticker.toUpperCase()) ?? null;
}

/**
 * The registered facts of `ticker`, whatever its spelling; throws when it has no row. The process
 * cache is reloaded once before throwing, so a row another process wrote is found.
 */
export function requireMarketSymbol(ticker: string): MarketSymbolRow {
  const hit = marketSymbol(ticker);
  if (hit != null) return hit;
  reloadMarketSymbols();
  const row = cache!.get(ticker.toUpperCase());
  if (row == null) {
    throw new Error(
      `${ticker} is not registered in market_symbols; run \`npm run register:market-symbols -w nw-tracker-server\``
    );
  }
  return row;
}

/**
 * Writes (or updates) `ticker`'s row from what `source` states, stamped verified now, and refreshes
 * the process cache. Refuses facts that would reframe a stored series: when `equity_daily` holds
 * bars for the ticker, the quote currency must be the bars' own, and a re-registration may not
 * change the market kind or the quote currency — a series in another currency or on another
 * calendar is a data problem to fix, never something to relabel.
 */
export function registerInstrument(
  ticker: string,
  facts: InstrumentFacts,
  source: InstrumentSource,
  now: Date = new Date()
): MarketSymbolRow {
  const key = ticker.trim().toUpperCase();
  if (!key) throw new Error("registerInstrument: empty ticker");
  if (!facts.display_symbol.trim()) throw new Error(`registerInstrument: ${key} has no display symbol`);
  if (facts.quote_currency != null && stmtKnownCurrency.get(facts.quote_currency) == null) {
    throw new Error(`registerInstrument: ${key} is quoted in ${facts.quote_currency}, which is not in the currencies table`);
  }
  const bars = stmtStoredBarCurrencies.all(key) as { currency: string | null; n: number }[];
  if (bars.length > 0) {
    const existing = stmtOne.get(key) as MarketSymbolRow | undefined;
    if (existing != null && (existing.market_kind !== facts.market_kind || existing.quote_currency !== facts.quote_currency)) {
      throw new Error(
        `registerInstrument: ${key} is registered as ${existing.market_kind}/${quoteCurrencyLabel(existing.quote_currency)} with stored ` +
          `equity_daily bars; ${source} now states ${facts.market_kind}/${quoteCurrencyLabel(facts.quote_currency)} — fix the stored series, never reframe it`
      );
    }
    const other = bars.filter((b) => b.currency !== facts.quote_currency);
    if (other.length > 0) {
      throw new Error(
        `registerInstrument: ${key} has ${other.map((b) => `${b.n} equity_daily bar(s) in ${quoteCurrencyLabel(b.currency)}`).join(", ")}; ` +
          `${source} states ${quoteCurrencyLabel(facts.quote_currency)} — fix the stored series, never reframe it`
      );
    }
  }
  const row: MarketSymbolRow = {
    ticker: key,
    quote_currency: facts.quote_currency,
    market_kind: facts.market_kind,
    isin: facts.isin ?? null,
    display_symbol: facts.display_symbol.trim().toUpperCase(),
    name: facts.name,
    exchange: facts.exchange,
    instrument_type: facts.instrument_type,
    source,
    verified_at: now.toISOString(),
  };
  stmtUpsert.run(row);
  if (cache == null) reloadMarketSymbols();
  else cache.set(key, row);
  return row;
}

/** The facts part of a registered row (to compare a declaration against a provider's statement). */
export function instrumentFactsOf(row: MarketSymbolRow): InstrumentFacts {
  return {
    quote_currency: row.quote_currency,
    market_kind: row.market_kind,
    exchange: row.exchange,
    name: row.name,
    instrument_type: row.instrument_type,
    display_symbol: row.display_symbol,
    isin: row.isin,
  };
}

/**
 * Every ticker the app prices, from every table that names one: stock and coin accounts, option
 * underlyings, the watchlist's equity rows, the benchmarks, the proxy basket's price tickers and
 * the stored daily closes. Sorted, upper-cased, distinct.
 */
export function tickersInUse(): string[] {
  const rows = db
    .prepare(
      `SELECT upper(trim(equity_ticker)) AS t FROM accounts WHERE COALESCE(trim(equity_ticker), '') <> ''
       UNION SELECT upper(trim(underlying_ticker)) FROM option_contracts
       UNION SELECT upper(trim(series_key)) FROM market_display_series WHERE kind = 'equity' AND COALESCE(trim(series_key), '') <> ''
       UNION SELECT upper(trim(ticker)) FROM benchmarks WHERE COALESCE(trim(ticker), '') <> ''
       UNION SELECT upper(trim(ticker)) FROM watchlist_composite_holdings
       UNION SELECT DISTINCT upper(ticker) FROM equity_daily
       ORDER BY 1`
    )
    .all() as { t: string }[];
  return rows.map((r) => r.t);
}

/** The tickers in use ({@link tickersInUse}) the registry has no row for. */
export function unregisteredTickersInUse(): string[] {
  reloadMarketSymbols();
  return tickersInUse().filter((t) => !cache!.has(t));
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
