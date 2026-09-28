/**
 * One-time cleanup of deposits linked twice through the synthetic checking-gap mirrors.
 *
 * Three causes, all fixed in the link sync:
 *   1. `syncBudaAbonoDepositMirrors` gave every Buda abono a synthetic cuenta_corriente mirror,
 *      assuming the cartolas did not cover the Buda era. They do, so an abono already linked to its
 *      real cartola debit also carried a mirror and a second (synthetic) link. The sync now skips an
 *      abono with a real outflow link (`listBudaAbonosWithoutRealOutflowLink`).
 *   2. A mirror's gastos line (category `deposits`, no auto note) took the manual-assertion pass and
 *      was linked again to its own deposit as `auto`. Mirror ids were rebuilt on every sync, so most
 *      of those links named a mirror id that no longer existed. Mirror lines now skip that pass.
 *   3. The matcher's deposit pool held the Buda-funded coin accounts, so a coin buy on the same day
 *      for the same pesos claimed the checking debit that funded the abono. Those accounts are now
 *      out of both matcher pools.
 *
 * The script runs the same link sync the expenses page runs, inside one transaction, and reports
 * what it changed: mirror rows, links, and the deposits reconciliation statuses. Without --apply the
 * transaction is rolled back, so the report IS the plan. Nothing here touches a movement, so
 * balances, deposits and P/L cannot move.
 *
 *   npx tsx scripts/remove-redundant-deposit-mirror-links.ts            # report only
 *   npx tsx scripts/remove-redundant-deposit-mirror-links.ts --apply
 */
import { db } from "../src/db.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";
import { buildDepositsReconciliationPayload } from "../src/flowsDepositsReconciliation.js";
import {
  CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX,
  isCheckingGapDepositMirrorPurchaseKey,
} from "../src/checkingGapDepositMirrorKey.js";

const apply = process.argv.includes("--apply");

type State = {
  mirrors: Map<number, string>;
  links: Set<string>;
  status: Map<number, string>;
};

function mirrorLabel(key: string): string {
  // Mirror ids are rebuilt by other syncs, so compare mirror links by deposit, not by id.
  return isCheckingGapDepositMirrorPurchaseKey(key) ? `${CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX}*` : key;
}

function readState(): State {
  const mirrors = new Map(
    (
      db
        .prepare(`SELECT deposit_movement_id, amount_clp, note FROM checking_gap_deposit_mirrors`)
        .all() as { deposit_movement_id: number; amount_clp: number; note: string | null }[]
    ).map((r) => [r.deposit_movement_id, `${r.amount_clp} ${r.note ?? ""}`])
  );
  const links = new Set(
    (
      db
        .prepare(`SELECT deposit_movement_id, link_source, purchase_key FROM expense_deposit_links`)
        .all() as { deposit_movement_id: number; link_source: string; purchase_key: string }[]
    ).map((r) => `deposit ${r.deposit_movement_id}  ${r.link_source}  ${mirrorLabel(r.purchase_key)}`)
  );
  const status = new Map(
    buildDepositsReconciliationPayload().rows.map((r) => [r.movement_id, r.status] as [number, string])
  );
  return { mirrors, links, status };
}

function report(before: State, after: State): number {
  let changes = 0;
  const removedMirrors = [...before.mirrors].filter(([dep]) => !after.mirrors.has(dep));
  const addedMirrors = [...after.mirrors].filter(([dep]) => !before.mirrors.has(dep));
  console.log(`Mirror rows removed: ${removedMirrors.length}`);
  for (const [dep, what] of removedMirrors) console.log(`  deposit ${dep}  ${what}`);
  console.log(`Mirror rows added: ${addedMirrors.length}`);
  for (const [dep, what] of addedMirrors) console.log(`  deposit ${dep}  ${what}`);
  const removedLinks = [...before.links].filter((l) => !after.links.has(l)).sort();
  const addedLinks = [...after.links].filter((l) => !before.links.has(l)).sort();
  console.log(`Links removed: ${removedLinks.length}`);
  for (const l of removedLinks) console.log(`  ${l}`);
  console.log(`Links added: ${addedLinks.length}`);
  for (const l of addedLinks) console.log(`  ${l}`);
  const statusChanges = [...new Set([...before.status.keys(), ...after.status.keys()])]
    .filter((id) => before.status.get(id) !== after.status.get(id))
    .sort((a, b) => a - b);
  const byTransition = new Map<string, number>();
  for (const id of statusChanges) {
    const t = `${before.status.get(id) ?? "(absent)"} -> ${after.status.get(id) ?? "(absent)"}`;
    byTransition.set(t, (byTransition.get(t) ?? 0) + 1);
  }
  console.log(`Deposits reconciliation status changes: ${statusChanges.length}`);
  for (const [t, n] of byTransition) console.log(`  ${n} × ${t}`);
  for (const id of statusChanges) {
    console.log(`  deposit ${id}: ${before.status.get(id) ?? "(absent)"} -> ${after.status.get(id) ?? "(absent)"}`);
  }
  changes += removedMirrors.length + addedMirrors.length + removedLinks.length + addedLinks.length;
  return changes;
}

class RollBack extends Error {}

try {
  db.transaction(() => {
    const before = readState();
    buildFlowsCreditCardExpensesPayload(); // runs syncExpenseDepositLinksFromGastosLines
    const after = readState();
    const changes = report(before, after);
    if (!apply) throw new RollBack();
    console.log(`\nApplied (${changes} mirror/link row change(s)).`);
  })();
} catch (e) {
  if (!(e instanceof RollBack)) throw e;
  console.log("\nReport only (rolled back). Re-run with --apply to write.");
}
