/**
 * One-time repair: Buda abonos whose real checking debit is hidden behind a stale «Único» category.
 *
 * The deposit matcher pairs a checking debit with the Buda abono it funded, but the gastos line only
 * records that pairing (the `auto:deposit-match` note the link sync reads) when the debit carries no
 * user-assigned category. Some Buda-era wires still carry categories from the retired excel import
 * (transport, supermarket, …), so their abonos kept a synthetic mirror instead of a link to the real
 * debit, and the wires counted as spending.
 *
 * The script runs the expenses link sync (the same one the expenses page runs), then looks at every
 * Buda abono still without a real outflow link. An abono qualifies when exactly one checking debit
 * of the same pesos sits within the matcher's three-day window, that debit pairs with no other such
 * abono, and its «Único» category is one that counts as spending. Those categories become
 * `deposits` (the matcher then links the debit), the sync runs again, and the script checks that
 * every repaired abono is now linked to its debit — else it throws and nothing is written.
 *
 * Everything runs in one IMMEDIATE transaction; without --apply it is rolled back, so the report IS
 * the plan. A second run finds nothing to do. No movement is touched, so balances, deposits and P/L
 * cannot move; gastos drop by the repaired wires.
 *
 *   npx tsx scripts/link-buda-abonos-behind-stale-categories.ts            # report only
 *   npx tsx scripts/link-buda-abonos-behind-stale-categories.ts --apply
 */
import { db } from "../src/db.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";
import { buildDepositsReconciliationPayload } from "../src/flowsDepositsReconciliation.js";
import {
  CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX,
  isCheckingGapDepositMirrorPurchaseKey,
} from "../src/checkingGapDepositMirrorKey.js";
import { listBudaAbonosWithoutRealOutflowLink } from "../src/budaWallet.js";
import { loadCheckingGastosWithdrawalRows } from "../src/checkingCartolaLoaders.js";
import { daysBetweenYmd } from "../src/checkingDescriptionPredicates.js";
import { checkingGastosMovementPurchaseKey } from "../src/flowsCheckingGastos.js";
import { listMovementBalanceCashAccountIds } from "../src/movementBalanceCashAccounts.js";
import { MOVEMENT_AMOUNT_COLUMNS_SQL, movementClpLegOrZero, type MovementAmountFields } from "../src/movementAmounts.js";
import {
  DEPOSITS_CC_EXPENSE_SLUG,
  getCcExpenseCategoryBySlug,
  isCcExpenseTotalsExcludedSlug,
} from "../src/ccExpenseCategories.js";

const apply = process.argv.includes("--apply");

/** The matcher's day window for an exact-date deposit (`splitCheckingWithdrawalAgainstDeposits`). */
const MATCH_MAX_DAY_GAP = 3;

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

function report(title: string, before: State, after: State): void {
  console.log(`\n=== ${title}`);
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
  console.log(`Deposits reconciliation status changes: ${statusChanges.length}`);
  for (const id of statusChanges) {
    console.log(`  deposit ${id}: ${before.status.get(id) ?? "(absent)"} -> ${after.status.get(id) ?? "(absent)"}`);
  }
}

type Repair = {
  abonoId: number;
  abonoOn: string;
  amountClp: number;
  debitId: number;
  debitAccountId: number;
  debitOn: string;
  purchaseKey: string;
  oldCategorySlug: string;
};

function planRepairs(): { repairs: Repair[]; skipped: string[] } {
  const abonoIds = [...listBudaAbonosWithoutRealOutflowLink()].sort((a, b) => a - b);
  const abonoStmt = db.prepare(`SELECT id, occurred_on, ${MOVEMENT_AMOUNT_COLUMNS_SQL} FROM movements WHERE id = ?`);
  const abonos = abonoIds.map((id) => {
    const r = abonoStmt.get(id) as ({ id: number; occurred_on: string } & MovementAmountFields) | undefined;
    if (r == null) throw new Error(`Buda abono ${id} not found`);
    return { id, occurred_on: r.occurred_on, amount: Math.round(movementClpLegOrZero(r)) };
  });
  const debits = listMovementBalanceCashAccountIds().flatMap((accountId) =>
    loadCheckingGastosWithdrawalRows(accountId).map((row) => ({ ...row, account_id: accountId }))
  );
  const categoryStmt = db.prepare(
    `SELECT c.slug FROM cc_expense_unique_purchases u
     LEFT JOIN cc_expense_categories c ON c.id = u.category_id
     WHERE u.account_id = ? AND u.purchase_key = ?`
  );
  const candidatesByAbono = new Map<number, typeof debits>();
  const abonosByDebit = new Map<number, number[]>();
  for (const a of abonos) {
    const hits = debits.filter(
      (d) =>
        Math.round(Math.abs(d.amount_clp)) === a.amount &&
        daysBetweenYmd(d.occurred_on, a.occurred_on) <= MATCH_MAX_DAY_GAP
    );
    candidatesByAbono.set(a.id, hits);
    for (const d of hits) abonosByDebit.set(d.id, [...(abonosByDebit.get(d.id) ?? []), a.id]);
  }
  const repairs: Repair[] = [];
  const skipped: string[] = [];
  for (const a of abonos) {
    const hits = candidatesByAbono.get(a.id)!;
    if (hits.length !== 1) {
      skipped.push(`abono ${a.id} ${a.occurred_on}: ${hits.length} checking debit(s) in the window`);
      continue;
    }
    const d = hits[0]!;
    if (abonosByDebit.get(d.id)!.length !== 1) {
      skipped.push(`abono ${a.id}: debit ${d.id} also pairs with abono(s) ${abonosByDebit.get(d.id)!.join(", ")}`);
      continue;
    }
    const purchaseKey = checkingGastosMovementPurchaseKey(d.id);
    const cat = categoryStmt.get(d.account_id, purchaseKey) as { slug: string | null } | undefined;
    if (cat == null || cat.slug == null || isCcExpenseTotalsExcludedSlug(cat.slug)) {
      skipped.push(
        `abono ${a.id}: debit ${d.id} has no spending «Único» category (${cat == null ? "no row" : cat.slug ?? "cleared"}) — not this repair`
      );
      continue;
    }
    repairs.push({
      abonoId: a.id,
      abonoOn: a.occurred_on,
      amountClp: a.amount,
      debitId: d.id,
      debitAccountId: d.account_id,
      debitOn: d.occurred_on,
      purchaseKey,
      oldCategorySlug: cat.slug,
    });
  }
  return { repairs, skipped };
}

class RollBack extends Error {}

try {
  db.transaction(() => {
    const initial = readState();
    buildFlowsCreditCardExpensesPayload(); // runs syncExpenseDepositLinksFromGastosLines
    const synced = readState();
    report("Link sync with the current matcher (before any category change)", initial, synced);

    const { repairs, skipped } = planRepairs();
    console.log(`\n=== Buda abonos behind a stale category: ${repairs.length}`);
    for (const r of repairs) {
      console.log(
        `  abono ${r.abonoId} ${r.abonoOn} ${r.amountClp} <- debit ${r.debitId} (account ${r.debitAccountId}, ${r.debitOn}) ${r.purchaseKey}: ${r.oldCategorySlug} -> ${DEPOSITS_CC_EXPENSE_SLUG}`
      );
    }
    console.log(`Buda abonos left as they are: ${skipped.length}`);
    for (const s of skipped) console.log(`  ${s}`);

    const deposits = getCcExpenseCategoryBySlug(DEPOSITS_CC_EXPENSE_SLUG);
    if (deposits == null) throw new Error(`category ${DEPOSITS_CC_EXPENSE_SLUG} missing`);
    const upd = db.prepare(
      `UPDATE cc_expense_unique_purchases SET category_id = ? WHERE account_id = ? AND purchase_key = ?`
    );
    for (const r of repairs) {
      if (upd.run(deposits.id, r.debitAccountId, r.purchaseKey).changes !== 1) {
        throw new Error(`category row for ${r.purchaseKey} changed under the script`);
      }
    }
    buildFlowsCreditCardExpensesPayload();
    const after = readState();
    report("After the category change", synced, after);

    const linkStmt = db.prepare(
      `SELECT 1 FROM expense_deposit_links
       WHERE deposit_movement_id = ? AND account_id = ? AND purchase_key = ? AND link_source = 'auto'`
    );
    const stillMirrored = listBudaAbonosWithoutRealOutflowLink();
    for (const r of repairs) {
      if (linkStmt.get(r.abonoId, r.debitAccountId, r.purchaseKey) == null || stillMirrored.has(r.abonoId)) {
        throw new Error(`abono ${r.abonoId} is not linked to debit ${r.debitId} after the repair — nothing written`);
      }
    }
    console.log(`\nBuda abonos still without a real outflow link: ${stillMirrored.size}`);
    for (const id of [...stillMirrored].sort((a, b) => a - b)) console.log(`  abono ${id}`);
    if (!apply) throw new RollBack();
    console.log(`\nApplied (${repairs.length} category row(s) changed).`);
  }).immediate();
} catch (e) {
  if (!(e instanceof RollBack)) throw e;
  console.log("\nReport only (rolled back). Re-run with --apply to write.");
}
