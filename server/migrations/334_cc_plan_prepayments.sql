-- A card plan the bank paid off at once (`ccPlanPrepayments.ts`). Santander's unbilled feed lists
-- «PREPAGO EN CUOTAS» for the whole outstanding principal of a plan (typically beside a nota de
-- crédito that refunds the purchase): the plan has no cuota left to bill, and the prepayment line
-- bills in the open facturación in its place. One row per prepaid plan; `paid_on` is the day the
-- plan left «cuotas por facturar», `amount_clp` the principal it paid off (the plan's total, no
-- cuota having billed). `line_id` is the bucket (later statement) line of the prepayment itself —
-- never an expense — and `credit_line_id` the refund credit paired with the same plan; both follow
-- the line when a statement settles the bucket and go NULL when it is deleted, the prepaid plan
-- standing on its own. The row goes with its plan.
CREATE TABLE cc_plan_prepayments (
  purchase_id INTEGER PRIMARY KEY REFERENCES cc_installment_purchases(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  paid_on TEXT NOT NULL CHECK (paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  line_id INTEGER UNIQUE REFERENCES cc_statement_lines(id) ON DELETE SET NULL,
  credit_line_id INTEGER UNIQUE REFERENCES cc_statement_lines(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cc_plan_prepayments_account ON cc_plan_prepayments(account_id)
