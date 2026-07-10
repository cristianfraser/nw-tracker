-- Places (expense_accounts) become fully data-driven:
-- - property_account_id ties a place to its net-worth property master, so mortgage
--   ledger rows attach per property instead of a hardcoded slug.
-- - comunidad_merchant_patterns (comma-separated) moves the per-place gastos-comunes
--   merchant patterns out of code. Values are personal data — set in the live DB only.
ALTER TABLE expense_accounts ADD COLUMN property_account_id INTEGER REFERENCES accounts(id);
ALTER TABLE expense_accounts ADD COLUMN comunidad_merchant_patterns TEXT;
