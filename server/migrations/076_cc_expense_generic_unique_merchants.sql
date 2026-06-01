-- Exact merchant keys that get persisted Único rows (see ccExpenseGenericUniqueMerchants.ts).

CREATE TABLE IF NOT EXISTS cc_expense_generic_unique_merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_key TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO cc_expense_generic_unique_merchants (merchant_key, sort_order) VALUES
  ('MACH ONE CLICK', 10),
  ('MACH WEBPAY ONECLICK', 20),
  ('TRASPASO A CUENTA DE OTRO BANCO', 30);
