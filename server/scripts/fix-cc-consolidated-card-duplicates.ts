/**
 * Remove duplicate CC data on superseded Santander cards (4111, 4112) after consolidation onto 4242.
 *
 *   npx tsx scripts/fix-cc-consolidated-card-duplicates.ts
 *   npx tsx scripts/fix-cc-consolidated-card-duplicates.ts --apply
 */
import { db } from "../src/db.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import {
  markSantanderCcSuperseded,
  purgeCcImportedDataForAccount,
  SANTANDER_CC_IMPORT_REDIRECT_LAST4,
} from "../src/ccConsolidatedCards.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccInstallmentLedgerDb.js";
import { resolveMasterAccountIdForCardLast4 } from "../src/creditCardTree.js";

const apply = process.argv.includes("--apply");

function masterId(last4: string): number | null {
  return resolveMasterAccountIdForCardLast4(last4);
}

function countDupStatements(fromId: number, toId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM cc_statements s
       WHERE s.account_id = ? AND s.source_pdf IN (
         SELECT source_pdf FROM cc_statements WHERE account_id = ?
       )`
    )
    .get(fromId, toId) as { c: number };
  return row.c;
}

function main() {
  const targetLast4 = "4242";
  const toId = masterId(targetLast4);
  if (toId == null) {
    console.error("4242 master account not found");
    process.exit(1);
  }

  for (const [fromLast4] of Object.entries(SANTANDER_CC_IMPORT_REDIRECT_LAST4)) {
    markSantanderCcSuperseded(fromLast4, targetLast4);
  }

  const plan: Record<string, unknown> = { apply, target: { last4: targetLast4, account_id: toId } };

  for (const fromLast4 of Object.keys(SANTANDER_CC_IMPORT_REDIRECT_LAST4)) {
    const fromId = masterId(fromLast4);
    if (fromId == null) continue;
    const dupStmts = countDupStatements(fromId, toId);
    const stmts = (
      db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE account_id = ?`).get(fromId) as {
        c: number;
      }
    ).c;
    const purchases = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM cc_installment_purchases WHERE account_id = ?`)
        .get(fromId) as { c: number }
    ).c;
    plan[fromLast4] = { account_id: fromId, statements: stmts, duplicate_statements_on_4242: dupStmts, purchases };

    if (apply) {
      const purged = purgeCcImportedDataForAccount(fromId);
      plan[`${fromLast4}_purged`] = purged;
    }
  }

  if (apply) {
    upsertCreditCardValuationsFromLedger(toId);
    recomputeCcBillingMonthBalances(toId);
  }

  console.log(JSON.stringify(plan, null, 2));
  if (!apply) console.log("Dry run — pass --apply to purge superseded card imports.");
}

main();
