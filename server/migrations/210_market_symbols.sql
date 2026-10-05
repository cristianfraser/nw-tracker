-- Watchlist symbols are checked against Yahoo before they are added (2026-10-04): a manual
-- `DXY` (a dead Nasdaq listing with no price — the dollar index is `DX-Y.NYB`) sat on the
-- watchlist as a row of dashes, its failures visible only in the server log.
--
-- `market_symbols` records what Yahoo said about a symbol when it was added: the currency its
-- price is quoted in — `none` for an index, whose level is points, not money, and is never
-- converted between CLP and USD — and the market whose calendar it trades on. A ticker with
-- no row keeps the old rule (`.SN` → CLP on the Santiago calendar, everything else USD).
CREATE TABLE IF NOT EXISTS market_symbols (
  ticker TEXT PRIMARY KEY,
  quote_currency TEXT NOT NULL CHECK (quote_currency IN ('usd', 'clp', 'none')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('nyse', 'santiago', 'crypto24')),
  name TEXT,
  exchange TEXT,
  instrument_type TEXT,
  verified_at TEXT NOT NULL
);

-- The last failure fetching a watchlist symbol, per stage, cleared by the next success — so the
-- watchlist can say why a row has no price.
CREATE TABLE IF NOT EXISTS market_symbol_fetch_errors (
  ticker TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('live', 'history')),
  message TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  PRIMARY KEY (ticker, stage)
);

-- Index levels are stored with currency `none`. Both tables enumerate the currency in a CHECK,
-- so they are rebuilt; nothing references either.
CREATE TABLE equity_daily_new (
  ticker TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency IN ('usd', 'clp', 'none')),
  PRIMARY KEY (ticker, trade_date)
);
INSERT INTO equity_daily_new (ticker, trade_date, close, currency)
  SELECT ticker, trade_date, close, currency FROM equity_daily;
DROP TABLE equity_daily;
ALTER TABLE equity_daily_new RENAME TO equity_daily;
CREATE INDEX IF NOT EXISTS idx_equity_daily_ticker_td ON equity_daily (ticker, trade_date);

CREATE TABLE live_market_quotes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'fx_clp_per_usd')),
  value REAL NOT NULL,
  currency TEXT CHECK (currency IN ('usd', 'clp', 'none')),
  session_ymd TEXT NOT NULL,
  previous_value REAL,
  fetched_at TEXT NOT NULL,
  CHECK ((kind = 'equity' AND currency IS NOT NULL) OR (kind = 'fx_clp_per_usd' AND currency IS NULL))
);
INSERT INTO live_market_quotes_new (id, symbol, kind, value, currency, session_ymd, previous_value, fetched_at)
  SELECT id, symbol, kind, value, currency, session_ymd, previous_value, fetched_at FROM live_market_quotes;
DROP TABLE live_market_quotes;
ALTER TABLE live_market_quotes_new RENAME TO live_market_quotes;
CREATE INDEX IF NOT EXISTS idx_live_market_quotes_symbol_kind_fetched
  ON live_market_quotes (symbol, kind, fetched_at DESC);
