-- A card statement line's kind in a column (docs/untangle-plan.md F10): what the line is —
-- card_purchase, card_refund, installment_cuota, card_payment, card_debt_transfer or
-- financing_charge (`CARD_LINE_KINDS`, nw-tracker-contracts `flowKinds.ts`) — decided once when
-- the line is written (`cards/lineKinds.ts`), never re-derived by its readers. The hook
-- (`cardLineKind276.ts`) fills the lines on file with the same classifier and reports the counts.
ALTER TABLE cc_statement_lines ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN (
  'card_purchase', 'card_refund', 'installment_cuota', 'card_payment', 'card_debt_transfer', 'financing_charge'
));
