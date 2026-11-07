-- Account roles (docs/untangle-plan.md F3, docs/untangle-valuation-core.md): what an account IS to
-- the code that needs one — a broker's cash in a currency, the Buda wallet, a Fintual goal, the
-- property and the loan of that property, a lender's statement pattern — as data instead of
-- import-key lookups scattered over the importers. The hook (`accountRoles271.ts`) installs the
-- triggers that keep the roles of the known identities in step with `accounts.import_key`, seeds
-- the existing accounts and adds the table's write-log triggers (F2).
CREATE TABLE IF NOT EXISTS account_roles (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('broker_cash', 'buda_wallet', 'fintual_goal', 'property', 'loan_of', 'lender_pattern')),
  param TEXT NOT NULL DEFAULT '',
  UNIQUE (account_id, role, param)
);
CREATE INDEX IF NOT EXISTS account_roles_role ON account_roles (role, param);
