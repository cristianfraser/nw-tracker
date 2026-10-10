-- A big group belongs to the expense, not to the account it was paid from: every purchase key
-- names one expense on its own (line-pr:<parser row>, installment-h:<account>:…,
-- checking-mv:<movement>, checking-cartola:<account>:…, manual:<id>), so the account column only
-- kept manual expenses (account 0) out. No stored key belonged to two accounts.
CREATE TABLE cc_expense_purchase_big_groups_new (
  purchase_key TEXT PRIMARY KEY,
  group_slug TEXT NOT NULL REFERENCES cc_expense_big_groups(slug) ON DELETE CASCADE
);
INSERT INTO cc_expense_purchase_big_groups_new (purchase_key, group_slug)
  SELECT purchase_key, group_slug FROM cc_expense_purchase_big_groups;
DROP TABLE cc_expense_purchase_big_groups;
ALTER TABLE cc_expense_purchase_big_groups_new RENAME TO cc_expense_purchase_big_groups;
CREATE INDEX idx_cc_expense_purchase_big_groups_slug
  ON cc_expense_purchase_big_groups(group_slug);
