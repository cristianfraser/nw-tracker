-- The user's income classification of a checking credit on its flow (docs/untangle-flow-identity.md,
-- F9 step 3): it follows the flow when the cartola replaces the daily row. No cascade, as before: a
-- flow still classified cannot be deleted, so a row that carries one is never dropped silently. The
-- hook (`flows/flowAssignments280.ts`) moves every row of `checking_income_movement_overrides`, proves
-- the mapping 1:1 and drops the old table.
CREATE TABLE flow_income_overrides (
  flow_id INTEGER PRIMARY KEY REFERENCES flows(id),
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_excluded IN (0, 1)),
  income_kind TEXT CHECK (income_kind IN ('salary', 'severance', 'other', 'parent_gift', 'card_reimbursement')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  force_include INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_flow_income_overrides_is_excluded ON flow_income_overrides(is_excluded);
