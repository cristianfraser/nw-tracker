/**
 * Alarm on card payments synthesized from a receipt whose checking debit no bank feed has
 * listed by the posting deadline (`santanderSyntheticCcPayments.ts`). The inbox pipeline runs it
 * on every run, right after the receipts are sent (`import:santander-receipts` in ingest) — the
 * check must not depend on new mail.
 *
 *   npm run check:synthetic-cc-payments -w nw-tracker-server
 */
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { loadRootDotenv } from "../src/rootDotenv.js";
import { listOverdueUnconfirmedSyntheticCcPayments } from "../src/santanderSyntheticCcPayments.js";

loadRootDotenv();
const overdue = listOverdueUnconfirmedSyntheticCcPayments(chileCalendarTodayYmd());
for (const o of overdue) {
  console.error(
    `⚠ synthesized card payment movement ${o.movement_id} (paid ${o.paid_on}, $${o.amount_clp}) has no bank ` +
      `listing by ${o.deadline ?? o.paid_on} — the debit its receipt describes never appeared in any bank ` +
      `feed; verify the checking account and delete the transfer if the money never left`
  );
}
if (overdue.length === 0) console.log("No synthesized card payment is overdue.");
process.exit(overdue.length > 0 ? 1 : 0);
