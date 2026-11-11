-- A mortgage lender's quote for its next cuota, as its portal states it (`mortgage.lender_statement`
-- v1; MetLife Hipotecario's «Centro de pago»): the minimum and maximum payment, the fee at the
-- reading's UF and its parts, the insurance in UF. One row per reading whose figures differ from
-- the previous row stored for that (lender, credit, cuota); an identical reading stores nothing.
-- `first_seen_at` is the read_at of the first reading of that cuota. `loan_account_id` is the loan
-- the lender resolved to when the reading was applied. The write-log triggers are added by the
-- migration's hook (`mortgageLenderQuotes308.ts`).
CREATE TABLE IF NOT EXISTS mortgage_lender_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lender TEXT NOT NULL,
  credit_number TEXT NOT NULL,
  loan_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cuota INTEGER NOT NULL CHECK (cuota > 0),
  due_on TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  fee_uf REAL NOT NULL,
  fee_pesos INTEGER NOT NULL,
  min_uf REAL NOT NULL,
  min_pesos INTEGER NOT NULL,
  max_uf REAL NOT NULL,
  max_pesos INTEGER NOT NULL,
  amortization_pesos INTEGER NOT NULL,
  interest_pesos INTEGER NOT NULL,
  default_interest_pesos INTEGER NOT NULL,
  collection_fee_pesos INTEGER NOT NULL,
  insurance_fire_uf REAL,
  insurance_life_uf REAL,
  insurance_other_uf REAL,
  read_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mortgage_lender_quotes_cuota ON mortgage_lender_quotes (lender, credit_number, cuota);
CREATE INDEX IF NOT EXISTS idx_mortgage_lender_quotes_loan ON mortgage_lender_quotes (loan_account_id, cuota);

-- The run asked the lender's portal to be read (`metlife_read` on the run request): the scheduler
-- reads it back so a portal is never read twice within an hour.
ALTER TABLE ingest_runs ADD COLUMN metlife_request TEXT CHECK (metlife_request IN ('quote', 'posted'));
ALTER TABLE ingest_runs ADD COLUMN metlife_request_reason TEXT;

-- The retired mortgage-sheet import (`mortgage.sheet_payments`, retired 2026-11-11): its record of
-- applied documents goes, triggers with it.
DROP TABLE IF EXISTS mortgage_sheet_imports;
