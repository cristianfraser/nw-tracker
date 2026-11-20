/**
 * Report-only: every card whose imported statements put two DIFFERENT closes of one currency in
 * one billing month (`sameMonthStatementConflicts`, `cards/facturacion.ts`) — the state the merge
 * import and the close rule refuse. Writes nothing. Exits 1 when any card trips it.
 *
 * Run (from server/, on a copy): NW_TRACKER_TEST_DB=/abs/copy.db npx tsx scripts/report-cc-same-month-statements.ts
 */
import { db } from "../src/db.js";
import { listCcStatementsForAccount } from "../src/ccStatementsDb.js";
import {
  describeSameMonthStatementConflicts,
  sameMonthStatementConflicts,
} from "../src/cards/facturacion.js";

const accountIds = (
  db.prepare(`SELECT DISTINCT account_id AS id FROM cc_statements ORDER BY account_id`).all() as { id: number }[]
).map((r) => r.id);

let tripped = 0;
for (const accountId of accountIds) {
  const statements = listCcStatementsForAccount(accountId);
  const conflicts = sameMonthStatementConflicts(statements);
  console.log(`account ${accountId}: ${statements.length} statement rows, ${conflicts.length} conflicting facturaciones`);
  if (conflicts.length) {
    tripped++;
    console.log(`  ${describeSameMonthStatementConflicts(conflicts).split("; ").join("\n  ")}`);
  }
}
console.log(tripped === 0 ? "No card trips the check." : `${tripped} card(s) trip the check.`);
process.exit(tripped === 0 ? 0 : 1);
