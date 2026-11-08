-- Big groups on the flow (docs/untangle-flow-identity.md, F9 step 3): a purchase's big group hangs
-- off its flow — a checking movement's deposit portion and a piece of a line keep their own
-- (`portion`, `piece_seq`, -1 = the whole flow). The hook (`flows/flowAssignments280.ts`) moves every
-- row of `cc_expense_purchase_big_groups`, archives the ones whose key names nothing, proves the
-- move and drops the old table.
CREATE TABLE flow_big_groups (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  portion TEXT NOT NULL DEFAULT 'gastos' CHECK (portion IN ('gastos', 'deposit')),
  piece_seq INTEGER NOT NULL DEFAULT -1,
  group_slug TEXT NOT NULL REFERENCES cc_expense_big_groups(slug) ON DELETE CASCADE,
  PRIMARY KEY (flow_id, portion, piece_seq)
);
CREATE INDEX idx_flow_big_groups_slug ON flow_big_groups(group_slug);
