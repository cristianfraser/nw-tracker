/**
 * Import credit-card movements fetched by `scraper/` into the ledger.
 *
 *   npm run import:santander-movements -w nw-tracker-server            # import + archive
 *   npm run import:santander-movements -w nw-tracker-server -- --dry-run
 *
 * Report-first by default is deliberate for a path that writes to the real ledger.
 */
import {
  importStagedSantanderMovements,
  listSantanderMovementFiles,
  resolveSantanderMovementsDir,
} from "../src/santanderMovementsImport.js";
import { santanderMovementsByAccount } from "../src/santanderCardMovements.js";
import { masterAccountIdForSantanderAccount } from "../src/santanderAccountMap.js";
import fs from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const dir = resolveSantanderMovementsDir();
const files = listSantanderMovementFiles(dir);

if (files.length === 0) {
  console.log(`No fetched movement files in ${dir}. Run: npm run fetch:santander`);
  process.exit(0);
}

if (dryRun) {
  console.log(`Dry run — ${files.length} file(s) in ${dir}\n`);
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(file.split("/").pop());
    for (const group of santanderMovementsByAccount(parsed)) {
      const accountId = masterAccountIdForSantanderAccount(group.account);
      const byCurrency = group.lines.reduce<Record<string, number>>((acc, line) => {
        acc[line.currency] = (acc[line.currency] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`  account ${group.account} → id ${accountId}: ${group.lines.length} lines`, byCurrency);
    }
  }
  console.log("\nNothing written. Re-run without --dry-run to import.");
  process.exit(0);
}

const results = importStagedSantanderMovements(dir);
for (const result of results) {
  console.log(result.file);
  for (const account of result.accounts) {
    console.log(
      `  account ${account.account} (id ${account.account_id}): ` +
        `${account.inserted} inserted, ${account.skipped_duplicate} duplicate, ` +
        `batch ${account.batch_id ?? "-"}`
    );
  }
}
console.log(`\nImported ${results.length} file(s); originals moved to ${dir}/imported/`);
