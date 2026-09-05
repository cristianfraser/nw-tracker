/**
 * One-time cleanup for cuota-billing reference rows imported as purchases.
 *
 * At a facturación close, Santander's movement feed lists each cuota billing that cycle as a row
 * whose merchant is the reference `CUOT: <cuota №>OPER: <plan №>` valued at the monthly cuota
 * (first seen 2026-08-25 on the ·0901 master: 20 rows, 1.xxx.xxx CLP). Those rows re-list the
 * installment schedule the app already bills, so each one double-counts a cuota in the owed walk
 * and the open-month gastos. `importCcWebPasteLines` now skips them at import
 * (`isCcCuotaBillingReferenceMerchant`); this script removes the ones already stored.
 *
 * Report by default. `--apply` deletes them through the supported evidence path: the earliest
 * affected transaction date is read BEFORE deleting, then valuations (stamp purge + re-walk from
 * that date) and billing balances are recomputed per account.
 *
 *   npx tsx scripts/remove-cc-cuota-billing-lines.ts            # report only
 *   npx tsx scripts/remove-cc-cuota-billing-lines.ts --apply
 */
import { db } from "../src/db.js";
import { isCcCuotaBillingReferenceMerchant } from "../src/ccWebPasteParse.js";
import {
  deleteStatementLinesByIds,
  earliestTransactionDateForLineIds,
} from "../src/ccCrossImportDedupe.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";

const apply = process.argv.includes("--apply");

type LineRow = {
  id: number;
  account_id: number;
  source_pdf: string;
  transaction_date: string | null;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
};

// Scoped to web-paste buckets: only the feed / a manual paste can carry this rendering — a PDF
// statement bills cuotas as installment lines with real merchant names.
const rows = db
  .prepare(
    `SELECT l.id, s.account_id, s.source_pdf, l.transaction_date, l.merchant,
            l.amount_clp, l.amount_usd
     FROM cc_statement_lines l
     JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.source_pdf LIKE 'import:web-paste%'
     ORDER BY s.account_id, l.transaction_date, l.id`
  )
  .all() as LineRow[];

const matches = rows.filter((r) => isCcCuotaBillingReferenceMerchant(r.merchant));

if (matches.length === 0) {
  console.log("No cuota-billing reference lines found in web-paste buckets. Nothing to do.");
  process.exit(0);
}

const byAccount = new Map<number, LineRow[]>();
for (const r of matches) {
  const list = byAccount.get(r.account_id) ?? [];
  list.push(r);
  byAccount.set(r.account_id, list);
}

let totalClp = 0;
for (const [accountId, list] of byAccount) {
  const sumClp = list.reduce((s, r) => s + (r.amount_clp ?? 0), 0);
  totalClp += sumClp;
  console.log(`account ${accountId}: ${list.length} lines, sum CLP ${sumClp}`);
  for (const r of list) {
    console.log(
      `  line ${r.id}  ${r.transaction_date ?? "?"}  ${r.merchant}  ` +
        `clp=${r.amount_clp ?? ""} usd=${r.amount_usd ?? ""}  (${r.source_pdf})`
    );
  }
}
console.log(`TOTAL: ${matches.length} lines, sum CLP ${totalClp}`);

if (!apply) {
  console.log("\nReport only — re-run with --apply to delete (snapshot the DB first).");
  process.exit(0);
}

for (const [accountId, list] of byAccount) {
  const ids = list.map((r) => r.id);
  const removedFrom = earliestTransactionDateForLineIds(ids);
  const removed = deleteStatementLinesByIds(ids);
  upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: removedFrom });
  recomputeCcBillingMonthBalances(accountId);
  console.log(
    `account ${accountId}: deleted ${removed} lines, revalued from ${removedFrom ?? "(none)"}`
  );
}
console.log("Done.");
