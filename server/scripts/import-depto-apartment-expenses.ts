/**
 * Import apartment utility expenses from `cfraser/depto-Table 1-2.csv` into `expense_entries`.
 *
 *   npm run import:depto-expenses -w nw-tracker-server -- --dry-run
 *   npm run import:depto-expenses -w nw-tracker-server -- --apply
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeptoTable12ApartmentExpenses } from "../src/deptoApartmentExpensesParse.js";
import { expenseAccountIdByGroupSlug } from "../src/flowsExpenses.js";
import { db } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfraserDir = path.resolve(__dirname, "..", "..", "cfraser");

function parseArgs(argv: string[]) {
  let dryRun = true;
  for (const a of argv) {
    if (a === "--apply") dryRun = false;
    if (a === "--dry-run") dryRun = true;
  }
  return { dryRun };
}

function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const parsed = loadDeptoTable12ApartmentExpenses(cfraserDir);
  if (parsed.length === 0) {
    console.error(`No rows parsed from ${path.join(cfraserDir, "depto-Table 1-2.csv")}`);
    process.exit(1);
  }

  const accountIds = {
    lastarria: expenseAccountIdByGroupSlug("real_estate", "lastarria"),
    suecia: expenseAccountIdByGroupSlug("real_estate", "suecia"),
  };
  if (accountIds.lastarria == null || accountIds.suecia == null) {
    console.error("Missing expense_accounts (run migrations 031 first).");
    process.exit(1);
  }

  if (!dryRun) {
    const del = db
      .prepare(`DELETE FROM expense_entries WHERE note LIKE 'import:depto-gastos|%'`)
      .run();
    console.log(`Deleted ${del.changes} prior depto-gastos expense row(s).`);
  }

  const ins = db.prepare(
    `INSERT INTO expense_entries (amount_clp, spent_on, category, note, expense_account_id)
     VALUES (?, ?, ?, ?, ?)`
  );

  let n = 0;
  const byApt = { lastarria: 0, suecia: 0 };
  for (const row of parsed) {
    const accountId = accountIds[row.apartment];
    if (accountId == null) continue;
    if (!dryRun) {
      ins.run(row.amount_clp, row.spent_on, row.category, row.note, accountId);
    }
    n += 1;
    byApt[row.apartment] += 1;
  }

  console.log(
    `${dryRun ? "Would insert" : "Inserted"} ${n} expense row(s): lastarria=${byApt.lastarria}, suecia=${byApt.suecia}`
  );
}

main();
