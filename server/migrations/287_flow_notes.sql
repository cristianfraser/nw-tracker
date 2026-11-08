-- Purchase notes on the flow (docs/untangle-flow-identity.md, F9 step 3): a purchase's note hangs
-- off its flow, portion and piece (`piece_seq` -1 = the whole flow), with the account it was written
-- under (`account_id`, the old key's scope: readers still ask by account). The hook
-- (`flows/flowAssignments280.ts`) moves every row of `cc_expense_purchase_notes`, archives the ones
-- whose key names nothing, proves the move and drops the old table.
CREATE TABLE flow_notes (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  portion TEXT NOT NULL DEFAULT 'gastos' CHECK (portion IN ('gastos', 'deposit')),
  piece_seq INTEGER NOT NULL DEFAULT -1,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (flow_id, portion, piece_seq)
);
CREATE INDEX idx_flow_notes_account ON flow_notes(account_id)
