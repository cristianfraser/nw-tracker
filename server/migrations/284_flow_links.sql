-- What a flow points at (docs/untangle-flow-identity.md, F9 step 3; F20 «Links»): one table for the
-- links a flow carries. This migration moves the first kind, `finances_facturado` (the plans that
-- paid another card's facturado, `cc_facturado_financing_link_purchases`); the deposit and bill
-- links follow. The hook (`flows/flowAssignments280.ts`) moves every row onto the flow its key
-- names, proves the move and drops the old table.
CREATE TABLE flow_links (
  id INTEGER PRIMARY KEY,
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  portion TEXT NOT NULL DEFAULT 'gastos' CHECK (portion IN ('gastos', 'deposit')),
  piece_seq INTEGER NOT NULL DEFAULT -1,
  kind TEXT NOT NULL CHECK (kind IN ('finances_facturado')),
  financing_link_id INTEGER REFERENCES cc_facturado_financing_links(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind <> 'finances_facturado' OR financing_link_id IS NOT NULL)
);
CREATE UNIQUE INDEX idx_flow_links_financing ON flow_links(financing_link_id, flow_id, portion, piece_seq)
  WHERE kind = 'finances_facturado';
CREATE INDEX idx_flow_links_flow ON flow_links(flow_id);
