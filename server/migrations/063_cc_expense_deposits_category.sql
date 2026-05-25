INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'deposits', 'Depósitos', 'expenses.creditCard.categories.deposits', 5, '#6366f1'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'deposits');
