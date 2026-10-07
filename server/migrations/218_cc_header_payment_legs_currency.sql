-- A header payment leg may be in dollars: old international statements print the period's abono
-- («ABONO REALIZADO») in the header with no line (·0161: −249,86 on 2017-10-24, −78,40 on
-- 2020-01-23), so the owed walk never subtracted it. `amount` is in the leg's currency.
CREATE TABLE cc_header_payment_legs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  statement_close_iso TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'clp' CHECK (currency IN ('clp', 'usd')),
  paid_on TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  source TEXT NOT NULL CHECK (source IN ('bank_debit', 'pay_by')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, statement_close_iso, currency, paid_on, amount)
);

INSERT INTO cc_header_payment_legs_new (id, account_id, statement_close_iso, currency, paid_on, amount, source, created_at)
SELECT id, account_id, statement_close_iso, 'clp', paid_on, amount_clp, source, created_at FROM cc_header_payment_legs;

DROP TABLE cc_header_payment_legs;

ALTER TABLE cc_header_payment_legs_new RENAME TO cc_header_payment_legs;

CREATE INDEX IF NOT EXISTS idx_cc_header_payment_legs_account
  ON cc_header_payment_legs (account_id, paid_on);
