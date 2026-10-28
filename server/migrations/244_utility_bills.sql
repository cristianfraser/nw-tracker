-- Utility bills (utility.bill): what each electricity / gas / water / internet bill charged and the
-- consumption it states, read from the provider's mail. A bill becomes the real-estate page's bill
-- row (expense_entries under its place) only once the card or checking charge that paid it is in;
-- `expense_entry_id` records the row it created or filled, and `settled_at` that it is done (a row
-- deleted by hand afterwards is not written again).

CREATE TABLE IF NOT EXISTS utility_bills (
  provider TEXT NOT NULL,
  bill_number TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('electricity', 'gas', 'water', 'internet')),
  service_account TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  due_on TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  kwh REAL,
  m3 REAL,
  estimated_reading INTEGER CHECK (estimated_reading IN (0, 1)),
  message_id TEXT NOT NULL,
  expense_entry_id INTEGER REFERENCES expense_entries(id) ON DELETE SET NULL,
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, bill_number)
);

-- Which real-estate place a provider's supply belongs to: personal data, set on the live DB only.
-- `service_account` is matched as printed on the bill, ignoring punctuation and leading zeros.
CREATE TABLE IF NOT EXISTS utility_service_accounts (
  provider TEXT NOT NULL,
  service_account TEXT NOT NULL,
  expense_account_id INTEGER NOT NULL REFERENCES expense_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, service_account)
);
