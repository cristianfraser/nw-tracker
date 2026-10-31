-- Expense category rules, global (no account): a general rule per vendor, and specific rules per
-- vendor + what the line is linked to (a receipt's store, an App Store app, a transfer's recipient).
-- The vendor is the vendor catalog's brand for the bank's merchant text (expenseCategoryRules.ts).
-- A post-migration hook converts the per-account cc_expense_merchant_categories rules into general
-- rules and drops that table (expenseCategoryRulesMigration.ts).
CREATE TABLE expense_category_rules (
  id INTEGER PRIMARY KEY,
  vendor TEXT NOT NULL CHECK (vendor <> ''),
  link_kind TEXT NOT NULL DEFAULT '' CHECK (link_kind IN ('', 'receipt', 'app', 'recipient')),
  link_key TEXT NOT NULL DEFAULT '',
  category_id INTEGER NOT NULL REFERENCES cc_expense_categories(id) ON DELETE RESTRICT,
  CHECK ((link_kind = '') = (link_key = '')),
  UNIQUE (vendor, link_kind, link_key)
);
