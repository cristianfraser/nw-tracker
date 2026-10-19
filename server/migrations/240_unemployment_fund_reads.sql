-- Each nightly read of the unemployment fund's (AFC) sucursal virtual: the balance its home page
-- stated (null when the page said «Saldo no disponible»), the app's own value of the account that
-- day, and the last contribution month the fund had credited. Report only: nothing acts on it.
CREATE TABLE unemployment_fund_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('afc')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  read_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  stated_pesos INTEGER,
  app_value_clp INTEGER NOT NULL,
  difference_clp INTEGER,
  last_contribution_month TEXT,
  unavailable_reason TEXT
);
CREATE INDEX unemployment_fund_reads_provider_read_at ON unemployment_fund_reads (provider, read_at);
