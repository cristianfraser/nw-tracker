-- Card payment lines the app planted in an open web-paste bucket before the bank listed the
-- payment (a receipt mail, a payment entered by hand). `source` is the import batch kind that
-- planted the line. The bank's own listing of the same payment (same currency and amount, dated
-- from the planted day to 5 days later) replaces the planted line whatever its wording; the row
-- goes with its line (ON DELETE CASCADE).
CREATE TABLE cc_planted_payment_lines (
  line_id INTEGER PRIMARY KEY REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('cc_santander_receipt', 'cc_manual_payment')),
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  amount REAL NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL CHECK (paid_on GLOB '????-??-??'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cc_planted_payment_lines_account ON cc_planted_payment_lines(account_id);

-- A card payment entered by hand (paid at a branch, from a dollar account — no receipt mail):
-- the cash → card `pago_tarjeta` transfer and the card's planted credit line. Confirmed when the
-- bank's listing replaces (or carries) the planted line.
CREATE TABLE cc_manual_payments (
  id INTEGER PRIMARY KEY,
  transfer_movement_id INTEGER NOT NULL UNIQUE REFERENCES movements(id) ON DELETE CASCADE,
  card_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  amount REAL NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL CHECK (paid_on GLOB '????-??-??'),
  planted_line_id INTEGER,
  confirmed_on TEXT,
  confirmed_by_line_merchant TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
