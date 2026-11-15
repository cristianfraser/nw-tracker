-- A nav role as data (docs/untangle-plan.md wave 8b): a deposit into this net-worth bucket is
-- money put to work outside cash (an investment contribution), not a move between cash accounts.
-- The checking matcher read it from a three-slug literal (`checkingDescriptionPredicates.ts`).
-- The hook (`investmentDepositTarget337.ts`) re-creates the table's write-log update trigger so
-- the new column counts as a write.
ALTER TABLE portfolio_groups ADD COLUMN investment_deposit_target INTEGER NOT NULL DEFAULT 0 CHECK (investment_deposit_target IN (0, 1));
UPDATE portfolio_groups SET investment_deposit_target = 1 WHERE slug IN ('real_estate', 'brokerage', 'retirement');
