-- Each read of a pension account's certificates the server received (docs/ingest-split-plan.md,
-- Phase 3): what it found and whether it wrote anything. The nightly schedule reads it — from the
-- 10th of a month the fund manager is checked every night until a read imports new rows cleanly,
-- then not again until the next 10th.
CREATE TABLE pension_account_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('afp_uno')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  source_ref TEXT NOT NULL,
  read_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
  new_rows INTEGER NOT NULL,
  inserted INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  problems_json TEXT NOT NULL
);
CREATE INDEX pension_account_reads_provider_read_at ON pension_account_reads (provider, read_at);
