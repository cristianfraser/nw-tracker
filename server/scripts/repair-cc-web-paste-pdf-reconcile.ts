/**
 * Delete web-paste one-shots on `open|{M}` that match PDF lines for closed month M.
 *
 *   npm run repair:cc-web-paste-pdf-reconcile -w nw-tracker-server -- --account-id=32 --billing-month=2026-06
 *   npm run repair:cc-web-paste-pdf-reconcile -w nw-tracker-server -- --account-id=32 --billing-month=2026-06 --apply
 */
import { reconcileOpenWebPasteAfterPdfClose } from "../src/ccOpenWebPastePdfReconcile.js";

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
  console.log(JSON.stringify(result, null, 2));
  if (dryRun && result.deleted_count > 0) {
    console.log("Dry run only — pass --apply to delete matched web-paste lines.");
  }
}

main();
