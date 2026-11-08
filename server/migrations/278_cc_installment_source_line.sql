-- A plan converted from a card line keeps the line (docs/untangle-plan.md F11, bug 17): the plan
-- names the line it was converted from, and the line stays on file — the purchases module counts the
-- purchase once (the plan overlays its line), the merge never deletes it as a superseded one-shot,
-- and deleting the plan (undo) leaves the line live again with its category, note and big group.
-- A line a re-import replaces takes the link with it (SET NULL): the plan then stands alone, as the
-- plans converted before this change do.
ALTER TABLE cc_installment_purchases ADD COLUMN source_line_id INTEGER
  REFERENCES cc_statement_lines(id) ON DELETE SET NULL;

-- Backfill: a hand-entered plan whose line is still on file — the one one-shot line of its account
-- with the plan's merchant, principal and purchase day. Until now a conversion deleted its line, so
-- most manual plans have none and stay unlinked.
UPDATE cc_installment_purchases
SET source_line_id = (
  SELECT MIN(l.id) FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
  WHERE s.account_id = cc_installment_purchases.account_id
    AND l.installment_flag = 0
    AND l.amount_clp = cc_installment_purchases.total_amount_clp
    AND l.merchant IS cc_installment_purchases.merchant
    AND (CASE WHEN length(l.transaction_date) = 8
              THEN '20' || substr(l.transaction_date, 7, 2) || '-' || substr(l.transaction_date, 4, 2) || '-' || substr(l.transaction_date, 1, 2)
              ELSE substr(l.transaction_date, 7, 4) || '-' || substr(l.transaction_date, 4, 2) || '-' || substr(l.transaction_date, 1, 2)
         END) = cc_installment_purchases.purchase_date
)
WHERE source = 'manual'
  AND (
    SELECT COUNT(*) FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
    WHERE s.account_id = cc_installment_purchases.account_id
      AND l.installment_flag = 0
      AND l.amount_clp = cc_installment_purchases.total_amount_clp
      AND l.merchant IS cc_installment_purchases.merchant
      AND (CASE WHEN length(l.transaction_date) = 8
                THEN '20' || substr(l.transaction_date, 7, 2) || '-' || substr(l.transaction_date, 4, 2) || '-' || substr(l.transaction_date, 1, 2)
                ELSE substr(l.transaction_date, 7, 4) || '-' || substr(l.transaction_date, 4, 2) || '-' || substr(l.transaction_date, 1, 2)
           END) = cc_installment_purchases.purchase_date
  ) = 1;

CREATE INDEX IF NOT EXISTS idx_cc_inst_purchases_source_line ON cc_installment_purchases(source_line_id);
