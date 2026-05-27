-- One-off cleanup: Vitest / merge-test rows that may have landed in nw-tracker.db.
-- Usage from repo root: sqlite3 server/data/nw-tracker.db < server/scripts/cleanup-cc-vitest-pollution.sql
-- After manual-installment deletes, recompute 4242 ledger/billing (see comment at end).

BEGIN IMMEDIATE;

-- ccManualInstallmentStatementReconcile.test.ts (fake PDFs + manual rows)
DELETE FROM cc_expense_line_categories
WHERE statement_line_id IN (
  SELECT l.id
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id
  WHERE s.source_pdf GLOB 'reconcile-*'
     OR l.merchant LIKE 'ZReconcile%'
);

DELETE FROM cc_statement_lines
WHERE statement_id IN (
  SELECT id FROM cc_statements WHERE source_pdf GLOB 'reconcile-*'
);

DELETE FROM cc_statements WHERE source_pdf GLOB 'reconcile-*';

DELETE FROM cc_expense_unique_purchases
WHERE purchase_key LIKE '%reconcile-test-%'
   OR purchase_key LIKE '%reconcile-out-%'
   OR purchase_key LIKE '%ZReconcile%';

DELETE FROM cc_installment_purchases
WHERE merchant LIKE 'ZReconcile%'
   OR canonical_row_id GLOB 'manual-out-reconcile-*'
   OR canonical_row_id GLOB 'manual-reconcile-test-*';

-- ccBillingViews.test.ts (createManualCcInstallmentPurchase)
DELETE FROM cc_installment_purchases
WHERE merchant IN ('Test manual facturado', 'Test manual Mar open bucket')
  AND source = 'manual';

-- ccExpenseCategories.test.ts (createManualCcInstallmentPurchase; has finally cleanup)
DELETE FROM cc_installment_purchases
WHERE merchant = 'TEST_MANUAL_CC_CONSOLIDATED_CAT' AND source = 'manual';

-- equityQuote.test.ts
DELETE FROM equity_daily WHERE ticker = 'SPY_TEST_DELTA';
DELETE FROM equity_daily WHERE ticker = 'BTC-USD' AND trade_date IN ('2099-06-01', '2099-05-31');

-- ccStatementsMerge.test.ts
DELETE FROM cc_statement_lines WHERE statement_id IN (
  SELECT id FROM cc_statements
  WHERE source_pdf IN (
    'import:web-paste|test-dedupe',
    'import:web-paste|test-overlap',
    'import:web-paste|vitest-cc-merge-dedupe',
    'import:web-paste|vitest-cc-merge-overlap'
  )
);

DELETE FROM cc_statements
WHERE source_pdf IN (
  'import:web-paste|test-dedupe',
  'import:web-paste|test-overlap',
  'import:web-paste|vitest-cc-merge-dedupe',
  'import:web-paste|vitest-cc-merge-overlap'
);

DELETE FROM cc_statement_lines
WHERE id IN (
  SELECT l.id
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id
  JOIN accounts a ON a.id = s.account_id
  WHERE a.notes = 'credit_card_master|santander|4242'
    AND l.amount_clp = 12345
    AND (l.merchant = 'TEST MERGE DEDUPE' OR l.merchant = 'Merge dedupe fixture row')
);

DELETE FROM cc_installment_purchases
WHERE card_group = 'santander'
  AND canonical_row_id IN ('test-overlap-canonical', 'vitest-cc-merge-overlap-canonical');

-- Vitest isolated master (should not exist in dev; safe no-op)
DELETE FROM cc_statement_lines
WHERE statement_id IN (
  SELECT id FROM cc_statements
  WHERE account_id IN (SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture')
);
DELETE FROM cc_statements
WHERE account_id IN (SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture');
DELETE FROM cc_installment_purchases
WHERE account_id IN (SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture');

COMMIT;

-- Optional after this file (4242 master):
--   cd server && npx tsx -e "
--     import { db } from './src/db.js';
--     import { upsertCreditCardValuationsFromLedger } from './src/ccInstallmentLedgerDb.js';
--     import { recomputeCcBillingMonthBalances } from './src/ccBillingBalances.js';
--     const r = db.prepare(\"SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'\").get() as { id: number } | undefined;
--     if (r) { upsertCreditCardValuationsFromLedger(r.id); recomputeCcBillingMonthBalances(r.id); }
--   "
