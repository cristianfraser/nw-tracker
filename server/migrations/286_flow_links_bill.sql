-- Bill links on the flow (docs/untangle-flow-identity.md, F9 step 3): the purchase that paid a
-- place bill is a `bill` link from the purchase's flow to the bill (`counterpart_entry_id`, an
-- `expense_entries` row with a place), with its `link_source`; a pairing the user refused is a
-- `flow_link_rejections` row. One bill per purchase and one purchase per bill, as before. The hook
-- (`flows/flowAssignments280.ts`) moves `real_estate_expense_links` and
-- `real_estate_expense_link_rejections`, archives the rows whose key names nothing, proves the
-- move and drops both tables.
CREATE TABLE flow_link_rejections (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  portion TEXT NOT NULL DEFAULT 'gastos' CHECK (portion IN ('gastos', 'deposit')),
  piece_seq INTEGER NOT NULL DEFAULT -1,
  kind TEXT NOT NULL CHECK (kind IN ('bill')),
  counterpart_entry_id INTEGER NOT NULL REFERENCES expense_entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, counterpart_entry_id, flow_id, portion, piece_seq)
);
CREATE INDEX idx_flow_link_rejections_flow ON flow_link_rejections(flow_id);
CREATE UNIQUE INDEX idx_flow_links_bill_entry ON flow_links(counterpart_entry_id) WHERE kind = 'bill';
CREATE UNIQUE INDEX idx_flow_links_bill_flow ON flow_links(flow_id, portion, piece_seq) WHERE kind = 'bill'
