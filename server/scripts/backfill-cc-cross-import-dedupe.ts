/**
 * Remove one-shot statement lines that duplicate an installment purchase
 * (same account, merchant, purchase date, total principal).
 *
 * Usage:
 *   npx tsx server/scripts/backfill-cc-cross-import-dedupe.ts
 *   npx tsx server/scripts/backfill-cc-cross-import-dedupe.ts --account-id 32
 *   npx tsx server/scripts/backfill-cc-cross-import-dedupe.ts --apply
 */
import {
  backfillCcCrossImportDedupe,
  oneShotStatementLineIdsSupersededByInstallmentPurchases,
} from "../src/ccCrossImportDedupe.js";
import { db } from "../src/db.js";

function parseAccountId(argv: string[]): number | undefined {
  const i = argv.indexOf("--account-id");
  if (i < 0) return undefined;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const accountId = parseAccountId(process.argv.slice(2));
const dryRun = !process.argv.includes("--apply");

if (dryRun) {
  const accountIds =
    accountId != null
      ? [accountId]
      : (
          db
            .prepare(
              `SELECT DISTINCT account_id AS id FROM cc_installment_purchases`
            )
            .all() as { id: number }[]
        ).map((r) => r.id);

  let total = 0;
  for (const id of accountIds) {
    const ids = [...oneShotStatementLineIdsSupersededByInstallmentPurchases(id)];
    if (ids.length > 0) {
      console.log(`account ${id}: would remove line ids ${ids.join(", ")}`);
      total += ids.length;
    }
  }
  console.log(`Dry run: ${total} line(s). Re-run with --apply to delete.`);
} else {
  const result = backfillCcCrossImportDedupe(accountId);
  console.log(JSON.stringify(result, null, 2));
}
