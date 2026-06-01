INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'checking_internal_transfer', 'Traspaso interno (cuentas)',
       'expenses.creditCard.categories.checking_internal_transfer', 6, '#818cf8'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'checking_internal_transfer');
