-- Why a loan payment's stated parts may miss its total (the lender's own row is short of what was
-- paid). Declared once per payment; the parts sync accepts the row while it is set. Replaces the
-- `accepted_differences` entries of the retired mortgage-sheet config (field `parts_sum`).
ALTER TABLE loan_payments ADD COLUMN parts_difference_reason TEXT;
