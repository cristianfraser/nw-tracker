-- Every core currency pair has a live rate (2026-11-12, docs/any-currency-plan.md C6): an fx row of
-- `live_market_quotes` is any pair, named by its key `<BASE>_<QUOTE>` (upper case: `USD_CLP` — the
-- live dollar, the only one until now —, `EUR_USD`), its value quote units per one base unit. The
-- kind `fx_clp_per_usd` becomes `fx`; the USD/CLP rows keep their symbol, value and ids.
CREATE TABLE live_market_quotes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'fx')),
  value REAL NOT NULL,
  currency TEXT REFERENCES currencies(code),
  session_ymd TEXT NOT NULL,
  previous_value REAL,
  fetched_at TEXT NOT NULL,
  CHECK (kind = 'equity' OR (kind = 'fx' AND currency IS NULL AND symbol GLOB '[A-Z][A-Z][A-Z]_[A-Z][A-Z][A-Z]'))
);
INSERT INTO live_market_quotes_new (id, symbol, kind, value, currency, session_ymd, previous_value, fetched_at)
SELECT id, symbol, CASE kind WHEN 'fx_clp_per_usd' THEN 'fx' ELSE kind END, value, currency, session_ymd,
       previous_value, fetched_at
  FROM live_market_quotes;
DROP TABLE live_market_quotes;
ALTER TABLE live_market_quotes_new RENAME TO live_market_quotes;
CREATE INDEX IF NOT EXISTS idx_live_market_quotes_symbol_kind_fetched
  ON live_market_quotes (symbol, kind, fetched_at DESC);
