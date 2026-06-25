-- Link gastos purchases (checking outflows) to net-worth deposit movements.
-- Used to split mortgage payments into carrying cost (bills) vs amortization (equity).

CREATE TABLE IF NOT EXISTS expense_deposit_links (
  account_id INTEGER NOT NULL,
  purchase_key TEXT NOT NULL PRIMARY KEY,
  deposit_movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  payment_clp INTEGER NOT NULL,
  amortization_clp INTEGER NOT NULL,
  depto_cuota TEXT,
  depto_occurred_on TEXT,
  link_source TEXT NOT NULL CHECK (link_source IN ('auto', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expense_deposit_links_movement
  ON expense_deposit_links(deposit_movement_id);

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT
  'real_estate_amortization',
  'Amortización hipoteca',
  'expenses.creditCard.categories.real_estate_amortization',
  4,
  '#6366f1'
WHERE NOT EXISTS (
  SELECT 1 FROM cc_expense_categories WHERE slug = 'real_estate_amortization'
);
