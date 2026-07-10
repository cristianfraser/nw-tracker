-- accounts.import_key: the machine identity previously packed into accounts.notes
-- (import find-or-create dedupe + well-known-account lookups). Backfilled verbatim from
-- the existing identity strings; notes stays as human provenance text and loses all
-- machine readers. liability_view|credit_card is NOT identity (duplicated, never matched)
-- and stays out of the unique key.

ALTER TABLE accounts ADD COLUMN import_key TEXT;

UPDATE accounts SET import_key = notes
WHERE notes LIKE 'import:%' OR notes LIKE 'credit_card_master|%' OR notes = 'liability_view|mortgage';

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_import_key ON accounts(import_key);
