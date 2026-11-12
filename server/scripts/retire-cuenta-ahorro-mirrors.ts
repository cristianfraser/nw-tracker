/**
 * The cuenta de ahorro's deposits get their real source (docs/untangle-flow-model.md B; user
 * decision 2026-11-08): the synthetic checking mirrors and the family / own funding splits are gone
 * (migration 294, which runs on the first boot of this code), and the deposits whose BancoEstado
 * transfer notices name their bank debit are linked to it — a `funded_deposit` link from the debit
 * (its deposit portion) to the deposit's flow, written by hand (`manual`), the debit categorised as
 * the matcher categorises a linked debit. Every other deposit stays unlinked.
 *
 *   npx tsx scripts/retire-cuenta-ahorro-mirrors.ts --plan=<json> [--apply]
 *
 * Plan: `{ ahorro_account_id, ahorro_links: [{deposit_month, debit_movement_id, amount, partial?}] }`
 * — the deposit is the ahorro deposit of that month that covers the amount and is not linked yet
 * (two debits may fund one deposit; `partial` says the link is below the deposit's amount). One
 * IMMEDIATE transaction, rolled back without `--apply`; inside it: the movements table is
 * untouched (so every balance on every date is), and the deposits reconciliation's resolved set
 * grows by exactly the linked deposits and nothing else moves. Report-first; the report prints
 * counts and the plan's own figures only.
 */
import fs from "node:fs";
import { getCcExpenseCategoryBySlug } from "../src/ccExpenseCategories.js";
import { loadDepositMatchCandidates } from "../src/checkingCartolaLoaders.js";
import { db } from "../src/db.js";
import { insertManualFundedDepositLink, linkedFundedDepositOf } from "../src/expenseDepositLinks.js";
import { autoMatchCategorySlugForDeposit } from "../src/flowsCheckingGastos.js";
import { buildDepositsReconciliationPayload } from "../src/flowsDepositsReconciliation.js";
import { movementClpLegOrZero, MOVEMENT_AMOUNT_COLUMNS_SQL, type MovementAmountFields } from "../src/movementAmounts.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const planPath = arg("plan");
if (!planPath) {
  console.error("--plan=<json> is required");
  process.exit(2);
}
type Plan = { ahorro_account_id: number; ahorro_links: { deposit_month: string; debit_movement_id: number; amount: number; partial?: boolean }[] };
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;
if (!Number.isInteger(plan.ahorro_account_id) || !Array.isArray(plan.ahorro_links) || plan.ahorro_links.length === 0) {
  throw new Error("plan: ahorro_account_id and a non-empty ahorro_links list are required");
}
for (const t of ["checking_gap_deposit_mirrors", "cuenta_ahorro_deposit_splits"]) {
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)) {
    throw new Error(`${t} still exists: run the server once so migration 294 retires it before linking`);
  }
}

type Deposit = MovementAmountFields & { id: number; occurred_on: string; flow_id: number };

/** The ahorro deposits of a month that cover the amount and carry no non-synthetic link yet. */
function candidateDeposits(month: string, amount: number): Deposit[] {
  return (
    db
      .prepare(
        `SELECT id, occurred_on, flow_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL} FROM movements
         WHERE account_id = ? AND substr(occurred_on, 1, 7) = ? ORDER BY id`
      )
      .all(plan.ahorro_account_id, month) as Deposit[]
  ).filter((d) => Math.round(movementClpLegOrZero(d)) >= amount);
}

function linkedClp(depositId: number): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(l.payment_clp), 0) AS clp FROM flow_links l
       WHERE l.kind = 'funded_deposit' AND l.counterpart_flow_id = (SELECT flow_id FROM movements WHERE id = ?)`
    )
    .get(depositId) as { clp: number };
  return r.clp;
}

const movementsFingerprint = () =>
  JSON.stringify(db.prepare(`SELECT COUNT(*) AS n, SUM(id) AS ids, SUM(amount) AS amt, MAX(occurred_on) AS d FROM movements`).get());

const before = buildDepositsReconciliationPayload("clp");
const statusBefore = new Map(before.rows.map((r) => [r.movement_id, r.status]));
const movementsBefore = movementsFingerprint();
const candidates = loadDepositMatchCandidates();

class RollBack extends Error {}
const linkedDeposits = new Set<number>();
let written = 0;
let already = 0;

const run = db.transaction(() => {
  for (const item of plan.ahorro_links) {
    const amount = Math.round(item.amount);
    const debit = db.prepare(`SELECT id, account_id, occurred_on, flow_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL} FROM movements WHERE id = ?`).get(item.debit_movement_id) as
      | (Deposit & { account_id: number | null })
      | undefined;
    if (!debit?.account_id) throw new Error(`debit ${item.debit_movement_id}: not a single-leg movement`);
    if (Math.round(movementClpLegOrZero(debit)) !== -amount) throw new Error(`debit ${item.debit_movement_id}: its pesos are not the plan's ${amount}`);
    // The deposit: among the month's deposits covering the amount, the ones still open for it.
    const open = candidateDeposits(item.deposit_month, amount).filter((d) => {
      const alreadyLinked = linkedFundedDepositOf(debit.id, d.id);
      if (alreadyLinked) return true; // its own link counts as open: the item is a re-run
      const room = Math.round(movementClpLegOrZero(d)) - linkedClp(d.id);
      return room >= amount;
    });
    // A deposit the debit already links is the one (a re-run, or the matcher got there first);
    // else a deposit of exactly the amount beats a bigger one.
    const linkedAlready = open.filter((d) => linkedFundedDepositOf(debit.id, d.id) != null);
    const exactFirst = open.filter((d) => Math.round(movementClpLegOrZero(d)) === amount);
    const pick = linkedAlready.length > 0 ? linkedAlready : exactFirst.length === 1 ? exactFirst : open;
    if (pick.length !== 1) {
      throw new Error(`debit ${item.debit_movement_id} (${item.deposit_month}): ${pick.length} ahorro deposit(s) could take ${amount} (${pick.map((d) => d.id).join(", ")})`);
    }
    const deposit = pick[0]!;
    const depositClp = Math.round(movementClpLegOrZero(deposit));
    if ((depositClp > amount) !== Boolean(item.partial) && linkedClp(deposit.id) === 0) {
      // A whole link of a bigger deposit (or a partial one that covers it) is not what the plan says.
      const others = plan.ahorro_links.filter((o) => o !== item && o.deposit_month === item.deposit_month).reduce((s, o) => s + Math.round(o.amount), 0);
      if (depositClp !== amount + others) throw new Error(`debit ${item.debit_movement_id}: deposit ${deposit.id} holds ${depositClp}, the plan links ${amount}${others ? ` + ${others}` : ""} and says ${item.partial ? "partial" : "whole"}`);
    }
    const existing = linkedFundedDepositOf(debit.id, deposit.id);
    if (existing) {
      if (existing.payment_clp !== amount) throw new Error(`debit ${item.debit_movement_id}: already linked to deposit ${deposit.id} for ${existing.payment_clp}, not ${amount}`);
      already += 1;
      console.log(`  ${item.deposit_month}: debit ${debit.id} → deposit ${deposit.id} already linked (${existing.link_source})`);
      continue;
    }
    insertManualFundedDepositLink({ outflowMovementId: debit.id, depositMovementId: deposit.id, paymentClp: amount });
    const candidate = candidates.find((c) => c.movement_id === deposit.id);
    if (!candidate) throw new Error(`deposit ${deposit.id} is not in the matcher's deposit pool`);
    const slug = autoMatchCategorySlugForDeposit(candidate);
    const category = getCcExpenseCategoryBySlug(slug);
    if (!category) throw new Error(`no category ${slug}`);
    db.prepare(
      `INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)
       ON CONFLICT(flow_id, portion, piece_seq) DO UPDATE SET category_id = excluded.category_id`
    ).run(debit.flow_id, debit.account_id, category.id);
    linkedDeposits.add(deposit.id);
    written += 1;
    console.log(`  ${item.deposit_month}: debit ${debit.id} → deposit ${deposit.id} linked for ${amount}${depositClp > amount ? ` of ${depositClp} (partial)` : ""}; debit categorised ${slug}`);
  }

  if (movementsFingerprint() !== movementsBefore) throw new Error("the movements table changed");
  const after = buildDepositsReconciliationPayload("clp");
  const moved: string[] = [];
  for (const r of after.rows) {
    const was = statusBefore.get(r.movement_id);
    if (was === r.status) continue;
    if (linkedDeposits.has(r.movement_id) && r.status === "linked") continue;
    moved.push(`${r.movement_id}: ${was} → ${r.status}`);
  }
  for (const id of linkedDeposits) {
    const row = after.rows.find((r) => r.movement_id === id);
    if (!row) throw new Error(`deposit ${id} left the reconciliation`);
    if (row.status !== "linked") throw new Error(`deposit ${id} reads ${row.status}, not linked`);
  }
  if (after.rows.length !== before.rows.length) throw new Error(`the reconciliation lists ${after.rows.length} rows, before ${before.rows.length}`);
  if (moved.length > 0) throw new Error(`other deposits moved: ${moved.join("; ")}`);
  console.log(`\nLinks: ${written} written, ${already} already there; ${linkedDeposits.size} deposit(s) newly linked.`);
  console.log(`Reconciliation: ${before.by_status.linked.count} linked before, ${after.by_status.linked.count} after; nothing else moved; movements untouched.`);
  if (!apply) throw new RollBack();
});

try {
  run.immediate();
  console.log(`\nApplied.`);
} catch (e) {
  if (e instanceof RollBack) console.log(`\nReport only — nothing written. Re-run with --apply.`);
  else {
    console.error(`\nFAILED (nothing written): ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
