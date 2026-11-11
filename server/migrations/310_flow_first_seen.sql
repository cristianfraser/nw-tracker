-- The Chile day a flow first reached the ledger (a card line's purchase, written by the statement /
-- listing import: `cards`' one line insert, `ccStatementsImport.ts`). Banks print a credit with the
-- original purchase's transaction date, so the home «Últimos movimientos» dates a card credit by
-- when it arrived. A flow that already has a row keeps it; a merge keeps the earlier day of the two
-- (`flows/flowIdentity.mergeFlowInto`), and a re-import that gives a line a new row carries the
-- vanished line's day (`flows/cardLineAdoption.adoptReimportedCardLines`). Moving forward only: no
-- history backfill. The write-log triggers are added by the migration's hook (`flows/flowFirstSeen310.ts`).
CREATE TABLE IF NOT EXISTS flow_first_seen (
  flow_id INTEGER PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  first_seen_on TEXT NOT NULL CHECK (first_seen_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
);
