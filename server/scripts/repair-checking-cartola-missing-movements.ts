/**
 * Backfill cuenta corriente cartola movements skipped by legacy note dedupe
 * (same description/month without date+amount in the movement note).
 *
 *   npm run repair:checking-cartola-missing-movements -w nw-tracker-server [--dry-run]
 */
import { backfillMissingCheckingCartolaMovements } from "../src/checkingCartolaImport.js";

const dryRun = process.argv.includes("--dry-run");
const result = backfillMissingCheckingCartolaMovements({ dryRun });
console.log(
  `${dryRun ? "[dry-run] " : ""}Inserted ${result.inserted} movement(s); skipped ${result.skipped} already present.`
);
if (result.byMonth.length > 0) {
  console.log("By month:");
  for (const row of result.byMonth) {
    console.log(`  ${row.period_month}: +${row.inserted} (${row.missing_before} were missing)`);
  }
} else {
  console.log("No missing movements found.");
}
