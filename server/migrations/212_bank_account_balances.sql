-- Deposit-account balances as the bank states them (bank_account.balances), and the nightly check
-- of the accounts the app knows against their ledgers.

-- Which app account a bank account number is. Declared once per account (personal data: set on
-- the live database only, never in a migration).
CREATE TABLE IF NOT EXISTS bank_account_numbers (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  number TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  UNIQUE (issuer, number, currency)
);

CREATE TABLE IF NOT EXISTS bank_account_balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ref TEXT NOT NULL,
  issuer TEXT NOT NULL,
  number TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('checking', 'demand_deposit')),
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  balance REAL NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_ref, issuer, number, currency)
);

CREATE INDEX IF NOT EXISTS idx_bank_account_balance_snapshots_account
  ON bank_account_balance_snapshots (account_id, observed_at);

CREATE TABLE IF NOT EXISTS bank_account_balance_checks (
  snapshot_id INTEGER PRIMARY KEY REFERENCES bank_account_balance_snapshots(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'mismatch')),
  ledger_balance REAL NOT NULL,
  diff REAL NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
