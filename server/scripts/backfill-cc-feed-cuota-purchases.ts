/**
 * Apply the feed's cuota-purchase rules (`ccFeedCuotaPurchases.ts`) to an ARCHIVED card-feed file:
 * create plans for cuota purchases whose count is known, re-pin hand-entered plans by the feed's
 * type, and tag the rest. Only the cuota steps run — re-importing an old feed wholesale could
 * re-insert rows the bank has since dropped.
 *
 *   npx tsx scripts/backfill-cc-feed-cuota-purchases.ts --file=<card-movements-*.json>           # report
 *   npx tsx scripts/backfill-cc-feed-cuota-purchases.ts --file=<card-movements-*.json> --apply
 *
 * Without --apply everything runs inside a transaction that is rolled back after printing, so the
 * report is exactly what --apply would write.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { santanderMovementsByAccount, type SantanderMovementsFile } from "../src/santanderCardMovements.js";
import { masterAccountIdForSantanderAccount } from "../src/santanderAccountMap.js";
import { createPlansForFeedCuotaPurchases, tagFeedCuotaPurchaseLines } from "../src/ccFeedCuotaPurchases.js";
import { applyWebPasteInstallmentFirstDueNudges } from "../src/ccWebPasteInstallmentNudge.js";

const apply = process.argv.includes("--apply");
const fileArg = process.argv.find((a) => a.startsWith("--file="))?.slice("--file=".length);
if (!fileArg) {
  console.error("Pass --file=<card-movements-*.json>");
  process.exit(1);
}
const file = path.resolve(fileArg);
const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SantanderMovementsFile;

class RollbackForReport extends Error {}

try {
  db.transaction(() => {
    for (const group of santanderMovementsByAccount(parsed)) {
      const typed = group.lines.filter((l) => l.cuota_purchase);
      if (typed.length === 0) continue;
      const accountId = masterAccountIdForSantanderAccount(group.account);
      console.log(`account ${group.account} (id ${accountId}): ${typed.length} cuota purchase row(s)`);
      for (const l of typed) {
        const cp = l.cuota_purchase!;
        console.log(
          `  ${l.transaction_date} ${l.merchant} ${Math.abs(l.amount_clp)} ${cp.kind}` +
            (cp.cuota_count != null ? ` · ${cp.cuota_count} cuotas (${cp.count_source})` : " · count unknown") +
            (cp.stamp_tax_clp != null ? ` · stamp tax ${cp.stamp_tax_clp}` : "")
        );
      }
      for (const p of createPlansForFeedCuotaPurchases(accountId, typed, path.basename(file))) {
        console.log(`  → plan ${p.purchase_id}: ${p.merchant} ${p.principal_clp} in ${p.cuotas}, first cuota ${p.first_due_month}`);
      }
      for (const n of applyWebPasteInstallmentFirstDueNudges(accountId, typed)) {
        console.log(`  → plan ${n.purchase_id} (${n.merchant}) first cuota ${n.from ?? "unset"} → ${n.to} [${n.rule}]`);
      }
      for (const id of tagFeedCuotaPurchaseLines(accountId, typed)) {
        console.log(`  → line ${id} tagged as a cuota purchase (count unknown)`);
      }
    }
    if (!apply) throw new RollbackForReport();
  })();
  console.log("\nApplied.");
} catch (err) {
  if (!(err instanceof RollbackForReport)) throw err;
  console.log("\nReport only — rolled back. Re-run with --apply to write.");
}
