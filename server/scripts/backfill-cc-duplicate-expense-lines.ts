/**
 * Remove duplicate CC statement lines that double-count gastos (re-imported PDFs, mixed date formats).
 *
 *   npx tsx scripts/backfill-cc-duplicate-expense-lines.ts
 *   npx tsx scripts/backfill-cc-duplicate-expense-lines.ts --apply
 */
import { planDuplicateExpenseLineFolds, removeDuplicateExpenseLines } from "../src/ccDuplicateExpenseLineRemoval.js";
import { dedupeFlowCcExpenseLines } from "../src/ccExpenseLineDedupe.js";
import { listCreditCardMasterAccountIdsForIssuer } from "../src/creditCardTree.js";
import { buildCcExpenseLines } from "../src/flowsExpenses.js";

const apply = process.argv.includes("--apply");

function main() {
  const accountIds = listCreditCardMasterAccountIdsForIssuer("santander");
  const raw = buildCcExpenseLines(accountIds, { dedupeDisplay: false });
  const kept = dedupeFlowCcExpenseLines(raw);
  const { folds, unfoldable } = planDuplicateExpenseLineFolds(raw);

  const plan = {
    apply,
    accounts: accountIds,
    raw_lines: raw.length,
    kept_lines: kept.length,
    drop_count: folds.length,
    folds_sample: folds.slice(0, 20).map((f) => `${f.fromLineId} -> ${f.intoLineId}`),
    left_alone_duplicates_of_plan_lines: unfoldable,
  };

  console.log(JSON.stringify(plan, null, 2));

  if (apply && folds.length > 0) {
    const removed = removeDuplicateExpenseLines(folds);
    console.log(`Removed ${removed} duplicate statement line(s), each folded into its kept twin.`);
  } else if (!apply && folds.length > 0) {
    console.log("Dry run — pass --apply to fold and delete duplicate lines.");
  }
}

main();
