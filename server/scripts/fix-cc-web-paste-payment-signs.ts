/**
 * Web paste stored PAGO / payments as positive charges (Math.abs).
 * DB convention: charges positive, payments negative (same as PDF MONTO CANCELADO).
 */
import { db } from "../src/db.js";
import { isCcPaymentMerchant } from "../src/ccPaymentLines.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";

const rows = db
  .prepare(
    `SELECT l.id, l.amount_clp, l.merchant, s.account_id, s.source_pdf
     FROM cc_statement_lines l
     JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.source_pdf LIKE 'import:web-paste%'
       AND l.amount_clp IS NOT NULL
       AND l.amount_clp > 0`
  )
  .all() as {
  id: number;
  amount_clp: number;
  merchant: string | null;
  account_id: number;
  source_pdf: string;
}[];

const update = db.prepare(`UPDATE cc_statement_lines SET amount_clp = ? WHERE id = ?`);
const touchedAccounts = new Set<number>();
let fixed = 0;

for (const row of rows) {
  if (!isCcPaymentMerchant(row.merchant)) continue;
  update.run(-Math.abs(row.amount_clp), row.id);
  touchedAccounts.add(row.account_id);
  fixed += 1;
  console.log(
    `account ${row.account_id} line ${row.id} ${row.merchant}: ${row.amount_clp} → ${-Math.abs(row.amount_clp)} (${row.source_pdf})`
  );
}

for (const accountId of touchedAccounts) {
  recomputeCcBillingMonthBalances(accountId);
  console.log(`recomputed billing balances for account ${accountId}`);
}

console.log(`fixed ${fixed} line(s) across ${touchedAccounts.size} account(s)`);
