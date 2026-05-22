-- Credit card expense category: excluded from counted gasto totals (see countsTowardCcExpenseTotals).

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'no_cuenta', 'No cuenta', 'expenses.creditCard.categories.no_cuenta', 5, '#475569'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'no_cuenta');
