-- Same-statement twin installment purchases (2026-09-26).
--
-- Buying the same item several times on one day, each in cuotas, prints identical cuota lines on
-- every statement (same merchant, date, amount, cuota N/T). The parser keeps them apart with an
-- occurrence suffix on the dedupe key (K, K#dup1, K#dup2), but the plan builder keyed a plan on
-- (date, total, cuotas, merchant) only, so the twins collapsed into one plan and the ledger
-- carried a third of the debt (2024-12: three identical purchases in 12 cuotas, one plan).
--
--   twin_index: which occurrence of that identity the plan is, 0-based (the Nth #dupN chain).
--   It is part of the plan identity everywhere plans are compared. Every existing plan is
--   occurrence 0, and hand-entered plans always are.
ALTER TABLE cc_installment_purchases ADD COLUMN twin_index INTEGER NOT NULL DEFAULT 0
  CHECK (twin_index >= 0);
