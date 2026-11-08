-- A line's pieces on its flow (docs/untangle-flow-identity.md, F9 step 3; bug 2): what a cash
-- withdrawal or a charge that paid for several things broke down into hangs off the flow of the line
-- it breaks down, so the pieces stay when the cartola row takes over a daily row's flow. F20 makes
-- them the flow's parts. The hook (`flows/flowAssignments280.ts`) moves every row of
-- `cc_expense_line_splits` onto its line's flow (a piece of a line no longer on file is archived),
-- proves the move and drops the old table.
CREATE TABLE flow_parts (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  category_id INTEGER NOT NULL REFERENCES cc_expense_categories(id),
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  note TEXT,
  spent_on TEXT CHECK (spent_on IS NULL OR spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (flow_id, seq)
);
