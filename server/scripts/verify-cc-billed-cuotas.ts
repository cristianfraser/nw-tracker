/**
 * Acceptance check for the installment ledger: for every closed facturación of every card, the
 * cuotas the statement bills must equal the ledger's `cuota_a_pagar_clp`, except the cuotas of
 * nota-cancelled plans (billed, but out of the schedule by design). Exits 1 on any other residual.
 *
 * Run (from server/): npx tsx scripts/verify-cc-billed-cuotas.ts [accountId ...]
 */
import { ccBilledCuotasIdentity } from "../src/ccBilledCuotasIdentity.js";
import { db } from "../src/db.js";

const argIds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const accountIds = argIds.length
  ? argIds
  : (
      db.prepare(`SELECT DISTINCT account_id AS id FROM cc_statements ORDER BY account_id`).all() as {
        id: number;
      }[]
    ).map((r) => r.id);

const fmt = (n: number) => n.toLocaleString("es-CL");

let unexplained = 0;
for (const accountId of accountIds) {
  const months = ccBilledCuotasIdentity(accountId);
  const cancelled = months.filter((m) => m.cancelled_clp !== 0);
  const bad = months.filter((m) => m.unexplained_clp !== 0);
  console.log(
    `account ${accountId}: ${months.length} closed facturaciones, ` +
      `${cancelled.length} with nota-cancelled cuotas, ${bad.length} unexplained`
  );
  for (const m of cancelled) {
    console.log(`  ${m.billing_month}  nota-cancelled cuotas ${fmt(m.cancelled_clp)} (by design)`);
  }
  for (const m of bad) {
    console.log(
      `  ${m.billing_month}  billed ${fmt(m.billed_clp)}  cuota a pagar ${fmt(m.cuota_a_pagar_clp)}` +
        `  UNEXPLAINED ${fmt(m.unexplained_clp)}`
    );
  }
  unexplained += bad.length;
}
console.log(
  unexplained === 0
    ? "\nevery closed facturación bills exactly its ledger cuotas"
    : `\n${unexplained} closed facturación(es) with an unexplained cuota residual`
);
process.exitCode = unexplained === 0 ? 0 : 1;
