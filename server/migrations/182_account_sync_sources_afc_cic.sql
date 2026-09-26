-- AFC (Fondo de Cesantía, Cuenta Individual) gets its own global-sync source, `afc_cic`: the
-- Superintendencia de Pensiones' public daily valor cuota lands in `fund_unit_daily` as series
-- `afc_cic`, and an AFC account declared on it (`accounts.fund_series_key`) is valued as a cuota
-- ledger — Σ units_delta × valor cuota at the date — like AFP UNO, instead of monthly stored
-- marks with book-value carry between them. `account_sync_sources.sync_source` is
-- CHECK-enumerated, so the table is rebuilt with the new value (same mechanics as 179). The
-- excel-era AFC account is declared on the series here: its import_key is its stable identity,
-- exactly as the AFP account is found by `import:excel|key=afp` in code. It is a child table
-- nothing references, so foreign keys stay ON for this migration.
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
UPDATE accounts
SET fund_series_key = 'afc_cic'
WHERE import_key = 'import:excel|key=afc'
  AND fund_series_key IS NULL;
INSERT OR IGNORE INTO account_sync_sources (account_id, sync_source)
SELECT id, 'afc_cic' FROM accounts WHERE fund_series_key = 'afc_cic'
