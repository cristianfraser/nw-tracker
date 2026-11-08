-- Flow retirement (docs/untangle-flow-identity.md, F9 step 4): a flow outlives the rows that
-- recorded it. When its last evidence row is deleted and something still hangs off it (a category,
-- a note, a big group, a piece, a link, a refund mark, an income classification), the flow is
-- retired instead of deleted: `retired_on` the day, and the document the evidence named
-- (`retired_source_table`, `retired_document_key`), so the same document arriving again adopts the
-- flow and every assignment returns with it. A key that names its row by id (`checking-mv:<id>`,
-- `line:<id>`, `installment:<id>`, `manual:<id>`, a gap mirror's) is detached into `retired_key`:
-- ids are reused (no AUTOINCREMENT), and a new row with the old id must not answer to the old flow.
-- The hook (`flows/flowRetirement290.ts`) replaces the delete triggers, fills the movements'
-- document keys, and retires/detaches what the data already holds (counts only in the report).
ALTER TABLE flows ADD COLUMN retired_on TEXT;
ALTER TABLE flows ADD COLUMN retired_key TEXT;
ALTER TABLE flows ADD COLUMN retired_source_table TEXT;
ALTER TABLE flows ADD COLUMN retired_document_key TEXT;
CREATE INDEX idx_flows_retired_document ON flows(retired_source_table, retired_document_key) WHERE retired_on IS NOT NULL;
