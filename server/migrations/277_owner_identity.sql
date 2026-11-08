-- Who the owner is, as the bank prints it (docs/untangle-plan.md F10): the name patterns its own
-- transfers carry («<owner> - SANTANDER») and, later, its RUT. The checking description rules
-- (server/src/cards/bankDescriptions.ts) read this table instead of a name written into the code,
-- and with no row they match nothing. The one name pattern the code held moves here, on a
-- database that already has accounts (a fresh database - the demo, the tests - gets its person's
-- row from the generator). The repository is public and the name is its author's attribution
-- anyway. The hook (ownerIdentity277.ts) adds the table's write-log triggers.
CREATE TABLE IF NOT EXISTS owner_identity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('name_pattern', 'rut')),
  value TEXT NOT NULL,
  UNIQUE (kind, value)
);
INSERT OR IGNORE INTO owner_identity (kind, value)
  SELECT 'name_pattern', 'TITULAR\s+DEMO' WHERE EXISTS (SELECT 1 FROM accounts);
