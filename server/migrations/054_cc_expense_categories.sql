-- Credit card expense categories (Flows > Gastos) and merchant / per-line assignments.

CREATE TABLE IF NOT EXISTS cc_expense_categories (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  label_i18n_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  chart_color TEXT NOT NULL DEFAULT '#94a3b8'
);

CREATE TABLE IF NOT EXISTS cc_expense_merchant_categories (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES cc_expense_categories(id) ON DELETE RESTRICT,
  UNIQUE(account_id, merchant_key)
);

CREATE INDEX IF NOT EXISTS idx_cc_expense_merchant_categories_account
  ON cc_expense_merchant_categories(account_id);

CREATE TABLE IF NOT EXISTS cc_expense_line_categories (
  statement_line_id INTEGER PRIMARY KEY REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES cc_expense_categories(id) ON DELETE RESTRICT
);

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'unclassified', 'Sin clasificar', 'expenses.creditCard.categories.unclassified', 0, '#64748b'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'unclassified');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'bills', 'Cuentas y servicios', 'expenses.creditCard.categories.bills', 10, '#f59e0b'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'bills');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'supermarket', 'Supermercado', 'expenses.creditCard.categories.supermarket', 20, '#22c55e'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'supermarket');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'restaurants', 'Restaurantes / delivery', 'expenses.creditCard.categories.restaurants', 30, '#ec4899'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'restaurants');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'takeout', 'Comida para llevar', 'expenses.creditCard.categories.takeout', 35, '#f472b6'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'takeout');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'transportation', 'Transporte', 'expenses.creditCard.categories.transportation', 40, '#0ea5e9'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'transportation');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'healthcare', 'Salud', 'expenses.creditCard.categories.healthcare', 50, '#14b8a6'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'healthcare');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'clothes', 'Ropa', 'expenses.creditCard.categories.clothes', 60, '#3b82f6'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'clothes');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'subscriptions', 'Suscripciones', 'expenses.creditCard.categories.subscriptions', 70, '#8b5cf6'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'subscriptions');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'fun', 'Ocio', 'expenses.creditCard.categories.fun', 80, '#a855f7'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'fun');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'trees', 'Jardín / plantas', 'expenses.creditCard.categories.trees', 85, '#84cc16'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'trees');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'others', 'Otros', 'expenses.creditCard.categories.others', 90, '#78716c'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'others');
