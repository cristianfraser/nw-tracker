/**
 * Settle the `open|{M}` web-paste bucket against month M's statement(s) — every currency once M is
 * fully closed, only the arrived twin's currency before (`reconcileOpenWebPasteAfterPdfClose`) —
 * then re-sync the card's valuation stamps from the earliest deleted line.
 *
 *   npm run repair:cc-web-paste-pdf-reconcile -w nw-tracker-server -- --account-id=32 --billing-month=2026-06
 *   npm run repair:cc-web-paste-pdf-reconcile -w nw-tracker-server -- --account-id=32 --billing-month=2026-06 --apply
 */
import { reconcileOpenWebPasteAfterPdfClose } from "../src/ccOpenWebPastePdfReconcile.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : null;
}

function main(): void {
  const accountIdRaw = readArg("account-id");
  const billingMonth = readArg("billing-month");
  if (!accountIdRaw || !billingMonth) {
    console.error("Usage: --account-id=N --billing-month=YYYY-MM [--apply]");
    process.exit(1);
  }
  const accountId = Number(accountIdRaw);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error(`Invalid --account-id=${accountIdRaw}`);
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const result = reconcileOpenWebPasteAfterPdfClose(accountId, billingMonth, { dryRun });
  if (!dryRun && (result.deleted_count > 0 || result.moved_count > 0)) {
    // The deleted lines were owed-walk evidence on their own dates: stamps after them are stale.
    upsertCreditCardValuationsFromLedger(accountId, {
      affectedEvidenceFromYmd: result.earliest_deleted_iso,
    });
  }
  console.log(JSON.stringify(result, null, 2));
  if (dryRun && result.deleted_count > 0) {
    console.log("Dry run only — pass --apply to delete matched web-paste lines.");
  }
}

main();
