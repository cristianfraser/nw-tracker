-- Payments the user declares because no document announces them (WIP: the shape may change as
-- more kinds arrive): one row per yearly payment, due on its month/day each year, at an estimated
-- amount, paid once an expense line matching its merchant pattern lands near its due date.
CREATE TABLE IF NOT EXISTS recurring_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  due_month INTEGER NOT NULL CHECK (due_month BETWEEN 1 AND 12),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  paid_merchant_pattern TEXT NOT NULL CHECK (length(trim(paid_merchant_pattern)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
