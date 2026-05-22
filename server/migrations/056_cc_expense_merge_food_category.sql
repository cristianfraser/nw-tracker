-- Merge restaurants + takeout into a single food category.

INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
SELECT 'food', 'Comida', 'expenses.creditCard.categories.food', 30, '#ec4899'
WHERE NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'food');

UPDATE cc_expense_merchant_categories
SET category_id = (SELECT id FROM cc_expense_categories WHERE slug = 'food')
WHERE category_id IN (
  SELECT id FROM cc_expense_categories WHERE slug IN ('restaurants', 'takeout')
);

UPDATE cc_expense_line_categories
SET category_id = (SELECT id FROM cc_expense_categories WHERE slug = 'food')
WHERE category_id IN (
  SELECT id FROM cc_expense_categories WHERE slug IN ('restaurants', 'takeout')
);

DELETE FROM cc_expense_categories WHERE slug IN ('restaurants', 'takeout');
