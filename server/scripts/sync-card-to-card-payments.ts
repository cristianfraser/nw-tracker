/**
 * Brings the card-to-card facturado payment transfers in line with the payment records
 * (`src/cardToCardPayments.ts`): lists every transfer the sync would create, replace or delete.
 * The card writes and the financing-link routes run the same sync; this is the backfill and the
 * check. Report-first: one IMMEDIATE transaction, rolled back without --apply.
 *
 *   npx tsx scripts/sync-card-to-card-payments.ts [--apply]   (from server/)
 */
import { db } from "../src/db.js";
import { syncCardToCardPaymentTransfers, type CardToCardPart } from "../src/cardToCardPayments.js";

const APPLY = process.argv.includes("--apply");

class Rollback extends Error {}

function describe(p: CardToCardPart & { movement_id: number }): string {
  return (
    `facturado ${p.financed_billing_month} of account ${p.to_account_id} ← account ${p.from_account_id}: ` +
    `${p.part_kind} ${p.part_ref}, $${p.amount_clp} on ${p.occurred_on} (movement ${p.movement_id})`
  );
}

let report = "";
try {
  db.transaction(() => {
    const r = syncCardToCardPaymentTransfers();
    const lines = [
      `create ${r.created.length}, replace ${r.updated.length}, delete ${r.deleted.length}, unchanged ${r.unchanged}`,
      ...r.created.map((p) => `  + ${describe(p)}`),
      ...r.updated.map((u) => `  ~ ${describe(u.before)}\n    → ${describe(u.after)}`),
      ...r.deleted.map((p) => `  - ${describe(p)}`),
    ];
    report = lines.join("\n");
    if (!APPLY) throw new Rollback();
  }).immediate();
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}
console.log(report);
console.log(APPLY ? "applied" : "report only (rolled back); pass --apply to write");
