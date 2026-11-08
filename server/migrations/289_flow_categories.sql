-- «Único» categories on the flow (docs/untangle-flow-identity.md, F9 step 3): a purchase marked
-- «Único» — with a category, or with none (it blocks the merchant rules) — is a `flow_categories`
-- row on its flow, portion and piece, with the account it was written under (`account_id`: readers
-- still ask by account). A per-line category (`cc_expense_line_categories`) stays a row of the
-- statement line: it names one line, never a key, and a cuota line's flow is its plan's. The hook
-- (`flows/flowAssignments280.ts`) moves every row of `cc_expense_unique_purchases`, archives the
-- ones whose key names nothing, proves the move and drops the old table.
CREATE TABLE flow_categories (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  portion TEXT NOT NULL DEFAULT 'gastos' CHECK (portion IN ('gastos', 'deposit')),
  piece_seq INTEGER NOT NULL DEFAULT -1,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES cc_expense_categories(id) ON DELETE SET NULL,
  PRIMARY KEY (flow_id, portion, piece_seq)
);
CREATE INDEX idx_flow_categories_account ON flow_categories(account_id)
