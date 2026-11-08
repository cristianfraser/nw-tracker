/**
 * Remove duplicate CC statement lines that double-count gastos (re-imported PDFs, mixed date formats).
 *
 *   npx tsx scripts/backfill-cc-duplicate-expense-lines.ts
 *   npx tsx scripts/backfill-cc-duplicate-expense-lines.ts --apply
 */
import { deleteLines } from "../src/cards/lineWrites.js";
import { dedupeFlowCcExpenseLines } from "../src/ccExpenseLineDedupe.js";
import { listCreditCardMasterAccountIdsForIssuer } from "../src/creditCardTree.js";
import { buildCcExpenseLines } from "../src/flowsExpenses.js";

const apply = process.argv.includes("--apply");

function main() {
  const accountIds = listCreditCardMasterAccountIdsForIssuer("santander");
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
    let removed = 0;
    for (const id of accountIds) {
      const own = new Set(raw.filter((l) => l.account_id === id).map((l) => l.statement_line_id));
      removed += deleteLines(id, dropIds.filter((lineId) => own.has(lineId)), { what: "removing duplicate expense lines" });
    }
    console.log(`Removed ${removed} duplicate statement line(s).`);
  } else if (!apply && dropIds.length > 0) {
    console.log("Dry run — pass --apply to delete duplicate lines.");
  }
}

main();
