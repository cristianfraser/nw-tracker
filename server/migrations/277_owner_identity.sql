-- Who the owner is, as the bank prints it (docs/untangle-plan.md F10): the name patterns its own
-- transfers carry («<owner> - SANTANDER») and, later, its RUT. The checking description rules
-- (server/src/cards/bankDescriptions.ts) read this table instead of a name written into the code,
-- and with no row they match nothing. The repository is public, so the migration seeds nothing: a
-- live database declares its owner once with `server/scripts/set-owner-identity.ts`; the demo and
-- the tests get their person's row from the generator. The hook (ownerIdentity277.ts) adds the
-- table's write-log triggers.
CREATE TABLE IF NOT EXISTS owner_identity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('name_pattern', 'rut')),
  value TEXT NOT NULL,
  UNIQUE (kind, value)
);
