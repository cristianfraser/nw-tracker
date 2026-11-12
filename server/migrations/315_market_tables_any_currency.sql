-- A market price may be quoted in any currency `currencies` holds (2026-11-12, any-currency plan
-- Phase B / C5): `market_symbols.quote_currency`, `equity_daily.currency` and
-- `live_market_quotes.currency` reference `currencies(code)` instead of a CHECK listing usd / clp.
-- An index level is points, not money: it was stored as `none`, and is now a NULL currency (the
-- column is nullable; the instrument's `instrument_type` says it is an index). The three columns
-- were CHECK lists, so the tables are rebuilt with foreign keys off; no foreign key references
-- them. Dropping a table drops its triggers: the hook `runMarketTablesAnyCurrency315` re-creates
-- the mark-input and write-log triggers of `market_symbols` and `equity_daily`
-- (`live_market_quotes` is not logged).
CREATE TABLE market_symbols_new (
  ticker TEXT PRIMARY KEY,
  quote_currency TEXT REFERENCES currencies(code),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('nyse', 'santiago', 'london', 'crypto24')),
  name TEXT,
  exchange TEXT,
  instrument_type TEXT,
  verified_at TEXT NOT NULL,
  isin TEXT,
  display_symbol TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'yahoo' CHECK (source IN ('yahoo', 'coingecko', 'bolsa_santiago', 'declared'))
);
INSERT INTO market_symbols_new (ticker, quote_currency, market_kind, name, exchange, instrument_type, verified_at, isin, display_symbol, source)
SELECT ticker, NULLIF(quote_currency, 'none'), market_kind, name, exchange, instrument_type, verified_at, isin, display_symbol, source FROM market_symbols;
DROP TABLE market_symbols;
ALTER TABLE market_symbols_new RENAME TO market_symbols;

CREATE TABLE equity_daily_new (
  ticker TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL NOT NULL,
  currency TEXT DEFAULT 'usd' REFERENCES currencies(code),
  PRIMARY KEY (ticker, trade_date)
);
INSERT INTO equity_daily_new (ticker, trade_date, close, currency)
SELECT ticker, trade_date, close, NULLIF(currency, 'none') FROM equity_daily;
DROP TABLE equity_daily;
ALTER TABLE equity_daily_new RENAME TO equity_daily;
CREATE INDEX IF NOT EXISTS idx_equity_daily_ticker_td ON equity_daily (ticker, trade_date);

-- An equity row's currency is its quote currency, NULL for an index; an fx-rate row has none.
CREATE TABLE live_market_quotes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'fx_clp_per_usd')),
  value REAL NOT NULL,
  currency TEXT REFERENCES currencies(code),
  session_ymd TEXT NOT NULL,
  previous_value REAL,
  fetched_at TEXT NOT NULL,
  CHECK (kind = 'equity' OR (kind = 'fx_clp_per_usd' AND currency IS NULL))
);
INSERT INTO live_market_quotes_new (id, symbol, kind, value, currency, session_ymd, previous_value, fetched_at)
SELECT id, symbol, kind, value, NULLIF(currency, 'none'), session_ymd, previous_value, fetched_at FROM live_market_quotes;
DROP TABLE live_market_quotes;
ALTER TABLE live_market_quotes_new RENAME TO live_market_quotes;
CREATE INDEX IF NOT EXISTS idx_live_market_quotes_symbol_kind_fetched
  ON live_market_quotes (symbol, kind, fetched_at DESC);
