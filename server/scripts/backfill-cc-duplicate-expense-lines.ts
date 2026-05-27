/**
 * Remove duplicate CC statement lines that double-count gastos (re-imported PDFs, mixed date formats).
 *
 *   npx tsx scripts/backfill-cc-duplicate-expense-lines.ts
 *   npx tsx scripts/backfill-cc-duplicate-expense-lines.ts --apply
 */
import { deleteStatementLinesByIds } from "../src/ccCrossImportDedupe.js";
import { dedupeFlowCcExpenseLines } from "../src/ccExpenseLineDedupe.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { listCreditCardGroupMasterAccountIds } from "../src/creditCardTree.js";
import { buildCcExpenseLines } from "../src/flowsCreditCardExpenses.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";

const apply = process.argv.includes("--apply");

function main() {
  const accountIds = listCreditCardGroupMasterAccountIds("santander");
  const raw = buildCcExpenseLines(accountIds, { dedupeDisplay: false });
  const kept = dedupeFlowCcExpenseLines(raw);
  const keptIds = new Set(kept.map((l) => l.statement_line_id));
  const dropIds = raw
    .filter((l) => !keptIds.has(l.statement_line_id))
    .map((l) => l.statement_line_id);

  const plan = {
    apply,
    accounts: accountIds,
    raw_lines: raw.length,
    kept_lines: kept.length,
    drop_count: dropIds.length,
    drop_ids_sample: dropIds.slice(0, 20),
  };

  console.log(JSON.stringify(plan, null, 2));

  if (apply && dropIds.length > 0) {
    const removed = deleteStatementLinesByIds(dropIds);
    for (const id of accountIds) {
      upsertCreditCardValuationsFromLedger(id);
      recomputeCcBillingMonthBalances(id);
    }
    console.log(`Removed ${removed} duplicate statement line(s).`);
  } else if (!apply && dropIds.length > 0) {
    console.log("Dry run — pass --apply to delete duplicate lines.");
  }
}

main();
