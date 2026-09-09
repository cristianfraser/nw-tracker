/**
 * Apply the Santander payment-receipt e-mails staged by `npm run fetch:santander-docs`: synthesize
 * the checking → card payment when the bank feed has not listed the debit yet, otherwise re-date
 * the next-workday debit to the payment day (see `santanderCcPaymentReceipts.ts`).
 *
 *   npm run import:santander-receipts                 # apply
 *   npm run import:santander-receipts -- --dry-run    # parse + report only
 *
 * Resolved receipts archive to `cfraser/santander-payment-receipts/processed/`; a receipt the
 * checking-anchor rule keeps waiting stays staged and retries on the next run. Every exit path
 * alerts on a synthesized payment whose debit no bank feed has listed by the posting deadline.
 */
import { importStagedPaymentReceipts, listStagedReceiptFiles } from "../src/santanderCcPaymentReceipts.js";
import { listOverdueUnconfirmedSyntheticCcPayments } from "../src/santanderSyntheticCcPayments.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

loadRootDotenv();
const dryRun = process.argv.includes("--dry-run");

/** Overdue synthesized payments are a data alarm on every exit path, quiet runs included. */
function finish(code: number): never {
  const overdue = listOverdueUnconfirmedSyntheticCcPayments(chileCalendarTodayYmd());
  for (const o of overdue) {
    console.error(
      `⚠ synthesized card payment movement ${o.movement_id} (paid ${o.paid_on}, $${o.amount_clp}) has no bank ` +
        `listing by ${o.deadline ?? o.paid_on} — the debit its receipt describes never appeared in any bank ` +
        `feed; verify the checking account and delete the transfer if the money never left`
    );
  }
  process.exit(overdue.length > 0 ? 1 : code);
}

if (listStagedReceiptFiles().length === 0) {
  console.log("No staged Santander payment receipts.");
  finish(0);
}

const results = importStagedPaymentReceipts({ dryRun });
for (const r of results) {
  const amount = `${r.receipt.amount_clp} clp${r.receipt.amount_usd != null ? ` (USD ${r.receipt.amount_usd})` : ""}`;
  console.log(
    `  ${r.receipt.paid_on}  ${r.receipt.kind.padEnd(3)} ·${r.receipt.card_last4 ?? "????"}  ${amount.padStart(24)}  [${r.status}] ${r.detail}`
  );
}
finish(0);
