-- A checking credit can be a refund of spending: money someone pays back for a shared expense, or an
-- additional cardholder paying back his charges. A refund is not income; it is a negative gastos line
-- in its category, so the category nets what was spent against what came back.
CREATE TABLE IF NOT EXISTS checking_expense_refunds (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES cc_expense_categories(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An additional cardholder's charges are their own category, counted in gastos and netted by the
-- cardholder's refunds (they were `no_cuenta`, out of gastos, set against `card_reimbursement` credits).
INSERT OR IGNORE INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color)
VALUES ('additional_card', 'Tarjeta adicional', 'expenses.creditCard.categories.additional_card', 87, '#f97316');

-- The charges the import auto-tagged (their machine note names them); a charge the user moved to
-- another category keeps it.
UPDATE cc_expense_unique_purchases
SET category_id = (SELECT id FROM cc_expense_categories WHERE slug = 'additional_card')
WHERE category_id = (SELECT id FROM cc_expense_categories WHERE slug = 'no_cuenta')
  AND EXISTS (
    SELECT 1 FROM cc_expense_purchase_notes n
    WHERE n.account_id = cc_expense_unique_purchases.account_id
      AND n.purchase_key = cc_expense_unique_purchases.purchase_key
      AND n.notes LIKE 'auto:additional-card|%'
  );

-- The cardholder's reimbursement credits become refunds in that category.
INSERT INTO checking_expense_refunds (movement_id, category_id)
SELECT movement_id, (SELECT id FROM cc_expense_categories WHERE slug = 'additional_card')
FROM checking_income_movement_overrides
WHERE income_kind = 'card_reimbursement' AND is_excluded = 0;

DELETE FROM checking_income_movement_overrides
WHERE income_kind = 'card_reimbursement' AND is_excluded = 0 AND force_include = 0 AND note IS NULL;
