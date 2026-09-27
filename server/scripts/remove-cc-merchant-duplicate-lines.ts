/**
 * One-time cleanup: run the open-bucket merchant-twin dedupe over every credit-card master.
 *
 * `removeTruncatedMerchantDuplicateLines` (`ccTruncatedMerchantDedupe.ts`) runs after every
 * web-paste / feed write, so rows that predate a rule only get swept by the next import that
 * touches that account. This script applies the current rules to the stored buckets directly —
 * first written 2026-09-05 for the six pending-authorization rows (short merchant name → settled
 * name + terminal code, US$xxx,xx on the ·0901 master) the feed had left behind.
 *
 * Report by default. `--apply` deletes them through the supported evidence path: the earliest
 * affected transaction date is read BEFORE deleting, then valuations (stamp purge + re-walk from
 * that date) and billing balances are recomputed per account.
 *
 *   npx tsx scripts/remove-cc-merchant-duplicate-lines.ts            # report only
 *   npx tsx scripts/remove-cc-merchant-duplicate-lines.ts --apply
 */
import { db } from "../src/db.js";
import {
  planTruncatedMerchantDuplicateLines,
  removeTruncatedMerchantDuplicateLines,
} from "../src/ccTruncatedMerchantDedupe.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";

const apply = process.argv.includes("--apply");

type LineRow = {
  id: number;
  transaction_date: string | null;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
};

const accountIds = (
  db
    .prepare(
      `SELECT DISTINCT account_id FROM cc_statements
       WHERE source_pdf LIKE 'import:web-paste%' ORDER BY account_id`
    )
    .all() as { account_id: number }[]
).map((r) => r.account_id);

const lineById = db.prepare(
  `SELECT id, transaction_date, merchant, amount_clp, amount_usd FROM cc_statement_lines WHERE id = ?`
);
const bucketCount = db.prepare(
  `SELECT COUNT(*) AS c FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND s.source_pdf LIKE 'import:web-paste%'`
);

function fmt(r: LineRow): string {
  const money = r.amount_usd != null && r.amount_usd !== 0 ? `usd=${r.amount_usd}` : `clp=${r.amount_clp}`;
  return `line ${r.id}  ${r.transaction_date ?? "?"}  ${r.merchant}  ${money}`;
}

function main(): void {
  let total = 0;
  const plans = new Map<number, ReturnType<typeof planTruncatedMerchantDuplicateLines>>();
  for (const accountId of accountIds) {
    const plan = planTruncatedMerchantDuplicateLines(accountId);
    const count = (bucketCount.get(accountId) as { c: number }).c;
    if (plan.length === 0) {
      console.log(`account ${accountId}: ${count} web-paste lines, nothing to remove`);
      continue;
    }
    plans.set(accountId, plan);
    total += plan.length;
    console.log(`account ${accountId}: ${count} web-paste lines, ${plan.length} to remove`);
    for (const p of plan) {
      const shorter = lineById.get(p.line_id) as LineRow;
      const longer = lineById.get(p.keep_line_id) as LineRow;
      console.log(`  [${p.rule}] remove ${fmt(shorter)}`);
      console.log(`  ${" ".repeat(p.rule.length + 2)} keep   ${fmt(longer)}`);
    }
  }
  console.log(`TOTAL: ${total} lines to remove across ${plans.size} account(s)`);

  if (total === 0) return;
  if (!apply) {
    console.log("\nReport only — re-run with --apply to delete (snapshot the DB first).");
    return;
  }

  for (const accountId of plans.keys()) {
    const before = (bucketCount.get(accountId) as { c: number }).c;
    const result = removeTruncatedMerchantDuplicateLines(accountId);
    upsertCreditCardValuationsFromLedger(accountId, {
      affectedEvidenceFromYmd: result.removed_from_date,
    });
    recomputeCcBillingMonthBalances(accountId);
    const after = (bucketCount.get(accountId) as { c: number }).c;
    console.log(
      `account ${accountId}: deleted ${result.removed_count} lines (${before} → ${after}), ` +
        `revalued from ${result.removed_from_date ?? "(none)"}`
    );
    for (const pair of result.removed_pairs) console.log(`  ${pair}`);
  }
  console.log("Done.");
}

main();
