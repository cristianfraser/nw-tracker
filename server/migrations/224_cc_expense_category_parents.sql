-- Subcategories: a category may name a parent (one level deep; the parent itself has none).
-- Today's categories are the parents. The expenses page shows either level.
ALTER TABLE cc_expense_categories ADD COLUMN parent_id INTEGER REFERENCES cc_expense_categories(id);

-- Payroll deductions recorded as expenses (docs/payroll-plan.md), under «Cuentas y servicios».
INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color, parent_id)
SELECT 'taxes', 'Impuestos', 'expenses.creditCard.categories.taxes', 11, '#d97706', id
  FROM cc_expense_categories WHERE slug = 'bills'
   AND NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'taxes');

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color, parent_id)
SELECT 'pension_fees', 'Comisiones AFP', 'expenses.creditCard.categories.pension_fees', 12, '#fbbf24', id
  FROM cc_expense_categories WHERE slug = 'bills'
   AND NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'pension_fees');
