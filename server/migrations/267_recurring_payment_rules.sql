-- Declared recurring payments, reworked (2026-11-05): an entry is manual (paid by hand, listed in
-- «Próximos pagos») or automatic (charged to the card; its lines are matched and shown apart); it
-- recurs yearly (its month and day each year) or monthly (its day each month); its amount is pesos
-- or UF; its lines are matched by a set of merchant patterns, a window around the due date and an
-- optional amount tolerance. The patterns move to a child table; the old single pattern column is
-- copied into it and dropped with the old table.
CREATE TABLE recurring_payments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  detail TEXT CHECK (detail IS NULL OR length(trim(detail)) > 0),
  manual INTEGER NOT NULL DEFAULT 1 CHECK (manual IN (0, 1)),
  frequency TEXT NOT NULL DEFAULT 'yearly' CHECK (frequency IN ('yearly', 'monthly')),
  due_month INTEGER CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'clp' CHECK (currency IN ('clp', 'uf')),
  match_days_before INTEGER NOT NULL DEFAULT 14 CHECK (match_days_before BETWEEN 0 AND 60),
  match_days_after INTEGER NOT NULL DEFAULT 7 CHECK (match_days_after BETWEEN 0 AND 60),
  amount_tolerance_pct REAL CHECK (amount_tolerance_pct IS NULL OR (amount_tolerance_pct > 0 AND amount_tolerance_pct <= 100)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((frequency = 'yearly' AND due_month IS NOT NULL) OR (frequency = 'monthly' AND due_month IS NULL))
);
INSERT INTO recurring_payments_new (id, name, detail, manual, frequency, due_month, due_day, amount, currency, match_days_before, match_days_after, amount_tolerance_pct, created_at)
SELECT id, name, detail, 1, 'yearly', due_month, due_day, amount_clp, 'clp', 14, 7, NULL, created_at FROM recurring_payments;
CREATE TABLE recurring_payment_patterns (
  recurring_payment_id INTEGER NOT NULL REFERENCES recurring_payments_new(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL CHECK (length(trim(pattern)) > 0),
  PRIMARY KEY (recurring_payment_id, pattern)
);
INSERT INTO recurring_payment_patterns (recurring_payment_id, pattern)
SELECT id, paid_merchant_pattern FROM recurring_payments;
DROP TABLE recurring_payments;
ALTER TABLE recurring_payments_new RENAME TO recurring_payments;
