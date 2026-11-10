-- The London Stock Exchange is the fourth market kind, `london` (`.L` lines: the USD-quoted
-- Irish UCITS ETFs CSPX.L and VWRA.L), on its own calendar — Europe/London, 08:00–16:30, the
-- England and Wales bank holidays — and with its own global-sync source, `stocks_london`, due
-- from 16:40 London on an LSE trading day. Until now every exchange suffix the app did not know
-- fell back to NYSE, so a `.L` line would have been priced on New York's sessions and synced by
-- `stocks_nyse` without a word; `equityMarketKind` now throws on an unknown suffix. Both
-- enumerations live in CHECK constraints, so the two tables are rebuilt (templates: 179 / 182 for
-- `account_sync_sources`, 210 for `market_symbols`). Neither is referenced by a foreign key —
-- `market_symbol_fetch_errors` keys on the ticker text — so foreign keys stay ON.
CREATE TABLE market_symbols_new (
  ticker TEXT PRIMARY KEY,
  quote_currency TEXT NOT NULL CHECK (quote_currency IN ('usd', 'clp', 'none')),
  market_kind TEXT NOT NULL CHECK (market_kind IN ('nyse', 'santiago', 'london', 'crypto24')),
  name TEXT,
  exchange TEXT,
  instrument_type TEXT,
  verified_at TEXT NOT NULL
);
INSERT INTO market_symbols_new (ticker, quote_currency, market_kind, name, exchange, instrument_type, verified_at)
SELECT ticker, quote_currency, market_kind, name, exchange, instrument_type, verified_at FROM market_symbols;
DROP TABLE market_symbols;
ALTER TABLE market_symbols_new RENAME TO market_symbols;
CREATE TABLE account_sync_sources_new (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sync_source TEXT NOT NULL CHECK (sync_source IN (
    'afp_uno',
    'afc_cic',
    'fintual',
    'sbif_usd',
    'sbif_eur',
    'sbif_uf',
    'sbif_utm',
    'sbif_ipc',
    'stocks_nyse',
    'stocks_santiago',
    'stocks_london',
    'yahoo_fx_usd',
    'crypto_eod'
  )),
  PRIMARY KEY (account_id, sync_source)
);
INSERT INTO account_sync_sources_new (account_id, sync_source)
SELECT account_id, sync_source FROM account_sync_sources;
DROP TABLE account_sync_sources;
ALTER TABLE account_sync_sources_new RENAME TO account_sync_sources;
CREATE INDEX IF NOT EXISTS idx_account_sync_sources_source ON account_sync_sources(sync_source)
