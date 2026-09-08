-- `.SN` (Bolsa de Santiago) tickers get their own global-sync source, `stocks_santiago`, on the
-- Chile calendar. Until now they rode `stocks_nyse`, whose due rule is the NYSE calendar, so a
-- US holiday that is a Chilean business day (2026-09-07, Labor Day) left the day's close
-- unsynced until the next NYSE session and the position sat on Friday's bar with a zero day
-- change. `account_sync_sources.sync_source` is CHECK-enumerated, so the table is rebuilt with
-- the new value and the Santiago accounts' links are re-pointed. It is a child table nothing
-- references, so foreign keys stay ON for this migration.
CREATE TABLE account_sync_sources_new (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sync_source TEXT NOT NULL CHECK (sync_source IN (
    'afp_uno',
    'fintual',
    'sbif_usd',
    'sbif_eur',
    'sbif_uf',
    'sbif_utm',
    'sbif_ipc',
    'stocks_nyse',
    'stocks_santiago',
    'yahoo_fx_usd',
    'crypto_eod'
  )),
  PRIMARY KEY (account_id, sync_source)
);
INSERT INTO account_sync_sources_new (account_id, sync_source)
SELECT account_id, sync_source FROM account_sync_sources;
DROP TABLE account_sync_sources;
ALTER TABLE account_sync_sources_new RENAME TO account_sync_sources;
CREATE INDEX IF NOT EXISTS idx_account_sync_sources_source ON account_sync_sources(sync_source);
UPDATE account_sync_sources
SET sync_source = 'stocks_santiago'
WHERE sync_source = 'stocks_nyse'
  AND account_id IN (
    SELECT id FROM accounts WHERE upper(trim(COALESCE(equity_ticker, ''))) LIKE '%.SN'
  )
