-- Refund marks on the flow (docs/untangle-flow-identity.md, F9 step 3; bug 2): a checking credit
-- that is a refund of spending keeps its mark and category when the cartola replaces its daily row,
-- since the cartola row takes over the daily row's flow. The hook (`flows/flowAssignments280.ts`)
-- moves every row of `checking_expense_refunds` onto its movement's flow, proves the mapping 1:1
-- and drops the old table.
CREATE TABLE flow_refunds (
  flow_id INTEGER PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES cc_expense_categories(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
