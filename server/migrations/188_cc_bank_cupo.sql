-- The bank's own credit line per card and currency, checked against the app (2026-09-27).
--
-- Santander's landing page requests a product summary once per login (`cruceProductosOnline`),
-- and its credit card rows state each card's cupo, cupo utilizado and cupo disponible in CLP and
-- in USD. The nightly fetcher keeps those rows in the card-movements file it already writes, and
-- `import:santander-movements` records them here. `check:cc-bank-cupo` then compares each
-- utilizado with what the app says the card owes in that currency, so a wrong ledger (the
-- 2026-09-27 duplicate installment plan counted a whole purchase twice) fails the nightly run
-- instead of waiting for someone to compare the two by hand.
--
--   cc_bank_cupo_captures: one row per fetched feed file that carried the summary, or said why it
--   could not (`error`). Exactly one of observed_at / error is set.
--
--   cc_bank_cupo_snapshots: the summary's rows, one per card master and currency, in currency
--   units (pesos, dollars). feed_close_iso is the SALDO INICIAL close the same file states for the
--   card, the close the comparison must share with the app.
--
--   cc_bank_cupo_checks: the verdict on one snapshot, with the app's terms at the time.
CREATE TABLE cc_bank_cupo_captures (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL UNIQUE,
  observed_at TEXT,
  error TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((observed_at IS NULL) <> (error IS NULL))
);

CREATE TABLE cc_bank_cupo_snapshots (
  id INTEGER PRIMARY KEY,
  capture_id INTEGER NOT NULL REFERENCES cc_bank_cupo_captures(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  bank_account TEXT NOT NULL,
  plastic_last4 TEXT NOT NULL,
  cupo_total REAL NOT NULL,
  cupo_utilizado REAL NOT NULL,
  cupo_disponible REAL NOT NULL,
  feed_close_iso TEXT,
  UNIQUE (capture_id, account_id, currency)
);

CREATE INDEX idx_cc_bank_cupo_snapshots_account ON cc_bank_cupo_snapshots (account_id, currency);

CREATE TABLE cc_bank_cupo_checks (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL UNIQUE REFERENCES cc_bank_cupo_snapshots(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'mismatch', 'indeterminate')),
  app_owed REAL,
  diff REAL,
  tolerance REAL,
  detail TEXT NOT NULL
);
