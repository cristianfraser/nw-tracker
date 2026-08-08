/**
 * Re-date checking card-payment debits from the Santander payment-receipt e-mails staged by
 * `npm run fetch:santander-docs` (see `santanderCcPaymentReceipts.ts` for the whole story).
 *
 *   npm run import:santander-receipts                 # apply
 *   npm run import:santander-receipts -- --dry-run    # parse + report only
 *
 * Resolved receipts archive to `cfraser/santander-payment-receipts/processed/`; a receipt whose
 * checking debit has not arrived yet stays staged and retries on the next run.
 */
import { importStagedPaymentReceipts, listStagedReceiptFiles } from "../src/santanderCcPaymentReceipts.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

loadRootDotenv();
const dryRun = process.argv.includes("--dry-run");

if (listStagedReceiptFiles().length === 0) {
  console.log("No staged Santander payment receipts.");
  process.exit(0);
}

const results = importStagedPaymentReceipts({ dryRun });
for (const r of results) {
  const amount = `${r.receipt.amount_clp} clp${r.receipt.amount_usd != null ? ` (USD ${r.receipt.amount_usd})` : ""}`;
  console.log(
    `  ${r.receipt.paid_on}  ${r.receipt.kind.padEnd(3)} ·${r.receipt.card_last4 ?? "????"}  ${amount.padStart(24)}  [${r.status}] ${r.detail}`
  );
}
