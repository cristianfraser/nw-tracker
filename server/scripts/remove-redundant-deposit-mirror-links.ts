/**
 * One-time cleanup of deposits linked twice through the synthetic checking-gap mirrors.
 *
 * Two sources of double links, both fixed in the link sync:
 *   1. `syncBudaAbonoDepositMirrors` gave every Buda abono a synthetic cuenta_corriente mirror,
 *      assuming the cartolas did not cover the Buda era. They do, so an abono already linked to its
 *      real cartola debit also carried a mirror and a second (synthetic) link. The sync now skips an
 *      abono with a real outflow link (`listBudaAbonosWithoutRealOutflowLink`).
 *   2. A mirror's gastos line (category `deposits`, no auto note) was treated as a user-asserted
 *      deposit and linked again to its own deposit as `auto`. Mirror ids are rebuilt on every sync,
 *      so most of those links named a mirror id that no longer exists. Mirror lines no longer take
 *      the assertion pass.
 *
 * The next expenses sync reaches the same state by itself; this makes the change explicit and
 * reviewable. Nothing here touches a movement, so balances, deposits and P/L cannot move; the
 * deposits reconciliation reads the links, so its statuses do (see the report).
 *
 * Report by default; `--apply` writes.
 *
 *   npx tsx scripts/remove-redundant-deposit-mirror-links.ts            # report only
 *   npx tsx scripts/remove-redundant-deposit-mirror-links.ts --apply
 */
import { db } from "../src/db.js";
import { listBudaAbonosWithoutRealOutflowLink, loadBudaBufferAccountId } from "../src/budaWallet.js";
import {
  CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX,
  checkingGapDepositMirrorPurchaseKey,
} from "../src/checkingGapDepositMirrorKey.js";

const apply = process.argv.includes("--apply");

type MirrorRow = { id: number; deposit_movement_id: number; amount_clp: number; occurred_on: string };
type LinkRow = { purchase_key: string; deposit_movement_id: number; payment_clp: number };

const budaId = loadBudaBufferAccountId();
const needsMirror = listBudaAbonosWithoutRealOutflowLink();

const redundantBudaMirrors: MirrorRow[] =
  budaId == null
    ? []
    : (
        db
          .prepare(
            `SELECT g.id, g.deposit_movement_id, g.amount_clp, g.occurred_on
             FROM checking_gap_deposit_mirrors g
             JOIN movements m ON m.id = g.deposit_movement_id
             WHERE m.account_id = ? AND m.note = 'import:buda|abono'
             ORDER BY g.occurred_on, g.id`
          )
          .all(budaId) as MirrorRow[]
      ).filter((g) => !needsMirror.has(g.deposit_movement_id));

const mirrorKeyAutoLinks = db
  .prepare(
    `SELECT l.purchase_key, l.deposit_movement_id, l.payment_clp
     FROM expense_deposit_links l
     WHERE l.link_source = 'auto' AND substr(l.purchase_key, 1, ?) = ?
     ORDER BY l.deposit_movement_id`
  )
  .all(
    CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX.length,
    CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX
  ) as LinkRow[];
const mirrorDepositById = new Map(
  (
    db.prepare(`SELECT id, deposit_movement_id FROM checking_gap_deposit_mirrors`).all() as {
      id: number;
      deposit_movement_id: number;
    }[]
  ).map((r) => [r.id, r.deposit_movement_id])
);
const mirrorIdOf = (key: string) => Number(key.slice(CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX.length));
const redundantMirrorIds = new Set(redundantBudaMirrors.map((g) => g.id));
// A live mirror's own link sits on the same (purchase_key, deposit) row the synthetic link sync writes,
// so the auto row is that link under the wrong source: relabel it. Any other mirror-key auto link goes.
const relabelLinks = mirrorKeyAutoLinks.filter(
  (l) =>
    !redundantMirrorIds.has(mirrorIdOf(l.purchase_key)) &&
    mirrorDepositById.get(mirrorIdOf(l.purchase_key)) === l.deposit_movement_id
);
const deleteLinks = mirrorKeyAutoLinks.filter((l) => !relabelLinks.includes(l));
const staleCount = mirrorKeyAutoLinks.filter((l) => !mirrorDepositById.has(mirrorIdOf(l.purchase_key))).length;

console.log(`Buda abono mirrors with a real outflow link (to delete, with their synthetic link): ${redundantBudaMirrors.length}`);
for (const g of redundantBudaMirrors) {
  console.log(`  mirror ${g.id}  deposit ${g.deposit_movement_id}  ${g.occurred_on}  ${g.amount_clp}`);
}
console.log(
  `Auto links from a mirror line to a deposit: ${mirrorKeyAutoLinks.length} ` +
    `(${staleCount} name a mirror id that no longer exists)`
);
console.log(`  to delete: ${deleteLinks.length}`);
for (const l of deleteLinks) {
  console.log(`    deposit ${l.deposit_movement_id}  ${l.purchase_key}  ${l.payment_clp}`);
}
console.log(`  to relabel synthetic (the mirror's own link): ${relabelLinks.length}`);
for (const l of relabelLinks) {
  console.log(`    deposit ${l.deposit_movement_id}  ${l.purchase_key}  ${l.payment_clp}`);
}

if (!apply) {
  console.log("\nReport only. Re-run with --apply to write.");
} else {
  const delMirror = db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE id = ?`);
  const delLink = db.prepare(
    `DELETE FROM expense_deposit_links WHERE purchase_key = ? AND deposit_movement_id = ?`
  );
  const relabel = db.prepare(
    `UPDATE expense_deposit_links SET link_source = 'synthetic'
     WHERE purchase_key = ? AND deposit_movement_id = ? AND link_source = 'auto'`
  );
  db.transaction(() => {
    for (const g of redundantBudaMirrors) {
      delLink.run(checkingGapDepositMirrorPurchaseKey(g.id), g.deposit_movement_id);
      if (delMirror.run(g.id).changes !== 1) throw new Error(`mirror ${g.id} vanished mid-run`);
    }
    for (const l of deleteLinks) {
      if (delLink.run(l.purchase_key, l.deposit_movement_id).changes !== 1) {
        throw new Error(`link ${l.purchase_key} → ${l.deposit_movement_id} vanished mid-run`);
      }
    }
    for (const l of relabelLinks) {
      if (relabel.run(l.purchase_key, l.deposit_movement_id).changes !== 1) {
        throw new Error(`link ${l.purchase_key} → ${l.deposit_movement_id} vanished mid-run`);
      }
    }
  })();
  console.log(
    `\nDeleted ${redundantBudaMirrors.length} mirror(s) and ${redundantBudaMirrors.length + deleteLinks.length} link(s); relabelled ${relabelLinks.length}.`
  );
}
