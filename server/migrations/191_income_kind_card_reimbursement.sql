-- A checking credit can be classified as a reimbursement of additional-card spending
-- (`income_kind = 'card_reimbursement'`): an additional cardholder paying back what his plastics
-- charged on the user's card. Those charges are auto-tagged `no_cuenta` (out of the user's
-- gastos), so the money paying them back is not income either; the income payload moves such
-- credits out of its income lines and the expenses payload sets them against the charges
-- («Tarjetas adicionales»). `income_kind` is CHECK-enumerated, so the table is rebuilt with the
-- new value (same mechanics as 179/182). It is a child table nothing references, so foreign keys
-- stay ON for this migration.
CREATE TABLE checking_income_movement_overrides_new (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id),
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_excluded IN (0, 1)),
  income_kind TEXT CHECK (income_kind IN (
    'salary',
    'severance',
    'other',
    'parent_gift',
    'card_reimbursement'
  )),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  force_include INTEGER NOT NULL DEFAULT 0
);
INSERT INTO checking_income_movement_overrides_new
  (movement_id, is_excluded, income_kind, note, updated_at, force_include)
SELECT movement_id, is_excluded, income_kind, note, updated_at, force_include
FROM checking_income_movement_overrides;
DROP TABLE checking_income_movement_overrides;
ALTER TABLE checking_income_movement_overrides_new RENAME TO checking_income_movement_overrides;
CREATE INDEX IF NOT EXISTS idx_checking_income_movement_overrides_is_excluded
  ON checking_income_movement_overrides(is_excluded)
