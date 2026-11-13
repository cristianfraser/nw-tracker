-- Card charge lines the app planted in an open listing bucket before the bank listed the purchase:
-- a Lider grocery receipt's line (batch kind `cc_lider_boleta`), a mortgage lender receipt's cuota
-- charge (`cc_lender_receipt`). `source` is the batch kind that planted the line. The bank's own
-- listing of the same purchase — same currency and amount, a matching merchant, dated the planted
-- day to 3 days later — is skipped as that purchase (`ccPlantedCharges.ts`): the bank sometimes
-- lists a Saturday purchase on Monday. The row goes with its line (ON DELETE CASCADE). The hook
-- registers the lines already on file from the receipts that wrote them.
CREATE TABLE cc_planted_charge_lines (
  line_id INTEGER PRIMARY KEY REFERENCES cc_statement_lines(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('cc_lider_boleta', 'cc_lender_receipt')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cc_planted_charge_lines_account ON cc_planted_charge_lines(account_id)
