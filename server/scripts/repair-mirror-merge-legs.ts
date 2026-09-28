/**
 * Repairs historical mirror-pair conversions (`movement_mirror_merges`, movementMirrorConvert.ts)
 * that absorbed the wrong bank row, or paired two rows that were never one transfer.
 *
 * The plan is a JSON file of explicit decisions, one per conversion (the audit that produced it
 * reads cartola descriptions and user notes — human evidence, never runtime logic):
 *
 *   [
 *     { "transfer": 11712, "action": "swap", "side": "out", "with": 8035 },
 *     { "transfer": 11719, "action": "undo" },
 *     { "action": "reject", "out": 9194, "in": 6483 }
 *   ]
 *
 * - `swap`: the conversion absorbed the wrong row on one side. The wrongly absorbed row comes back
 *   as its original single-leg movement (same id, date, amount, units, note — so everything keyed
 *   on it resolves again: `checking-cartola:` category/notes keys, legacy `checking-mv:<id>` keys),
 *   the named sibling is absorbed in its place (its content moves into the merge row, the row is
 *   deleted), and the transfer keeps its id with the date the conversion rule gives the new pair
 *   (outflow day, or the inflow day when only the outflow is month-precision).
 * - `undo`: both legs come back as their original single-leg movements (original ids), the
 *   transfer is deleted (its merge row cascades), and the pairing is recorded as a panel rejection
 *   (`movement_mirror_pair_rejections`) — the restored legs would otherwise be offered again.
 * - `reject`: a current candidate pairing of the same kind that was never converted is recorded as
 *   a rejection, so the panel never offers it.
 *
 * Fail fast: a sibling must be a single-leg CLP row on that side's account with the same amount
 * and no flow_kind, inside the pairing window; nothing may reference the transfer or the sibling
 * beyond what a conversion already drops (income overrides) — anything else throws. Every touched
 * account's balance is compared at each month-end of the affected months (must be unchanged), and
 * the checking ledger anchors are re-derived (stored vs derived must not move).
 *
 * Idempotent: an applied swap (merge row already names the sibling) or undo (transfer gone, legs
 * back) is reported as done. Report-first: without --apply the whole plan runs inside one
 * IMMEDIATE transaction that is rolled back after printing, so the report is the post-repair state.
 *
 *   npx tsx server/scripts/repair-mirror-merge-legs.ts --plan=<plan.json> [--apply]
 */
import fs from "node:fs";
import { accountKindSlugForAccountId } from "../src/accountBucket.js";
import { getCheckingLedgerAnchor, nonAnchorClpFlowTotals } from "../src/checkingCartolaBalances.js";
import { db } from "../src/db.js";
import { MIRROR_PAIR_MAX_DAY_GAP, mirrorLegIsMonthPrecision } from "../src/movementMirrorPairs.js";
import { listMovementBalanceCashAccountIds } from "../src/movementBalanceCashAccounts.js";

const APPLY = process.argv.includes("--apply");
const planPath = process.argv.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
if (!planPath) throw new Error("--plan=<plan.json> is required");

type PlanItem =
  | { transfer: number; action: "undo" }
  | { transfer: number; action: "swap"; side: "out" | "in"; with: number }
  | { action: "reject"; out: number; in: number };

function positiveId(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what}: bad id ${JSON.stringify(v)}`);
  return n;
}

function parsePlan(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("plan must be a non-empty array");
  const seen = new Set<number>();
  return raw.map((it, i): PlanItem => {
    const o = it as Record<string, unknown>;
    if (o.action === "reject") {
      return { action: "reject", out: positiveId(o.out, `plan[${i}].out`), in: positiveId(o.in, `plan[${i}].in`) };
    }
    const transfer = Number(o.transfer);
    if (!Number.isInteger(transfer) || transfer <= 0) throw new Error(`plan[${i}]: bad transfer`);
    if (seen.has(transfer)) throw new Error(`plan[${i}]: transfer ${transfer} listed twice`);
    seen.add(transfer);
    if (o.action === "undo") return { transfer, action: "undo" };
    if (o.action === "swap") {
      const side = o.side;
      const withId = Number(o.with);
      if (side !== "out" && side !== "in") throw new Error(`plan[${i}]: side must be out|in`);
      if (!Number.isInteger(withId) || withId <= 0) throw new Error(`plan[${i}]: bad with`);
      return { transfer, action: "swap", side, with: withId };
    }
    throw new Error(`plan[${i}]: action must be undo|swap|reject`);
  });
}

const plan = parsePlan(JSON.parse(fs.readFileSync(planPath, "utf8")));

type MergeRow = {
  transfer_movement_id: number;
  out_movement_id: number;
  out_occurred_on: string;
  out_amount_clp: number;
  out_units_delta: number | null;
  out_note: string | null;
  in_movement_id: number | null;
  in_occurred_on: string;
  in_amount_clp: number;
  in_units_delta: number | null;
  in_note: string | null;
};
type TransferRow = {
  id: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount: number;
  currency: string;
  occurred_on: string;
  units_delta: number | null;
  flow_kind: string | null;
};
type LegRow = {
  id: number;
  account_id: number | null;
  amount: number;
  currency: string;
  counter_amount: number | null;
  occurred_on: string;
  units_delta: number | null;
  note: string | null;
  flow_kind: string | null;
};
type Leg = { id: number; occurred_on: string; amount_clp: number; units_delta: number | null; note: string | null };

const getTransfer = db.prepare(
  `SELECT id, account_id, from_account_id, to_account_id, amount, currency, occurred_on, units_delta, flow_kind
   FROM movements WHERE id = ?`
);
const getMerge = db.prepare(`SELECT * FROM movement_mirror_merges WHERE transfer_movement_id = ?`);
const getLeg = db.prepare(
  `SELECT id, account_id, amount, currency, counter_amount, occurred_on, units_delta, note, flow_kind
   FROM movements WHERE id = ?`
);
const insLegWithId = db.prepare(
  `INSERT INTO movements (id, account_id, amount, currency, occurred_on, units_delta, note)
   VALUES (?, ?, ?, 'clp', ?, ?, ?)`
);
const delMovement = db.prepare(`DELETE FROM movements WHERE id = ?`);
const delIncomeOverride = db.prepare(`DELETE FROM checking_income_movement_overrides WHERE movement_id = ?`);
const insRejection = db.prepare(
  `INSERT OR IGNORE INTO movement_mirror_pair_rejections (out_movement_id, in_movement_id) VALUES (?, ?)`
);

/** Tables whose rows would silently cascade (or dangle) when a movement is deleted. */
const MOVEMENT_REFS: { table: string; column: string }[] = (
  db
    .prepare(
      `SELECT m.name AS tbl, p."from" AS col
       FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) p
       WHERE m.type = 'table' AND p."table" = 'movements'`
    )
    .all() as { tbl: string; col: string }[]
).map((r) => ({ table: r.tbl, column: r.col }));

/** Refuses when anything but `allowed` references the movement (fail fast, never cascade blind). */
function assertUnreferenced(movementId: number, allowed: Set<string>, what: string): void {
  for (const { table, column } of MOVEMENT_REFS) {
    if (allowed.has(table)) continue;
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`).get(movementId) as { n: number }
    ).n;
    if (n > 0) throw new Error(`${what} ${movementId} is referenced by ${table}.${column} (${n} row(s))`);
  }
}

function mergeLeg(m: MergeRow, side: "out" | "in"): Leg {
  const id = side === "out" ? m.out_movement_id : m.in_movement_id;
  if (id == null) throw new Error(`merge ${m.transfer_movement_id}: ${side} leg is not a movement`);
  return {
    id,
    occurred_on: side === "out" ? m.out_occurred_on : m.in_occurred_on,
    amount_clp: side === "out" ? m.out_amount_clp : m.in_amount_clp,
    units_delta: side === "out" ? m.out_units_delta : m.in_units_delta,
    note: side === "out" ? m.out_note : m.in_note,
  };
}

/**
 * Restores a merge's recorded leg under its original id, so rows keyed on the id (category splits,
 * legacy `checking-mv:<id>` keys) resolve again.
 */
function restoreLeg(accountId: number, leg: Leg): void {
  if (getLeg.get(leg.id)) throw new Error(`cannot restore leg ${leg.id}: the id is taken`);
  insLegWithId.run(leg.id, accountId, leg.amount_clp, leg.occurred_on, leg.units_delta, leg.note);
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function humanNote(outYmd: string, inYmd: string): string {
  return `Traspaso espejo (retiro ${outYmd} → depósito ${inYmd})`;
}

type Outcome = { label: string; status: "done" | "applied"; detail: string };

function runUndo(item: Extract<PlanItem, { action: "undo" }>): Outcome {
  const merge = getMerge.get(item.transfer) as MergeRow | undefined;
  const transfer = getTransfer.get(item.transfer) as TransferRow | undefined;
  if (!transfer) return { label: `transfer ${item.transfer}`, status: "done", detail: "undo: transfer already gone" };
  if (!merge) throw new Error(`movement ${item.transfer} is not a mirror-merge conversion`);
  if (transfer.from_account_id == null || transfer.to_account_id == null) {
    throw new Error(`movement ${item.transfer} is not a transfer row`);
  }
  const out = mergeLeg(merge, "out");
  const inn = mergeLeg(merge, "in");
  assertUnreferenced(item.transfer, new Set(["movement_mirror_merges"]), "transfer");
  restoreLeg(transfer.from_account_id, out);
  restoreLeg(transfer.to_account_id, inn);
  delMovement.run(item.transfer);
  // The restored legs would come straight back as a candidate; the rejection is the record that
  // this pairing was reviewed and is not a transfer.
  insRejection.run(out.id, inn.id);
  return {
    label: `transfer ${item.transfer}`,
    status: "applied",
    detail:
      `undo: restored out ${out.id} (${transfer.from_account_id}, ${out.occurred_on}) and ` +
      `in ${inn.id} (${transfer.to_account_id}, ${inn.occurred_on}); transfer deleted`,
  };
}

function runSwap(item: Extract<PlanItem, { action: "swap" }>): Outcome {
  const merge = getMerge.get(item.transfer) as MergeRow | undefined;
  const transfer = getTransfer.get(item.transfer) as TransferRow | undefined;
  if (!transfer || !merge) throw new Error(`transfer ${item.transfer} is not a mirror-merge conversion`);
  if (transfer.from_account_id == null || transfer.to_account_id == null || transfer.flow_kind != null) {
    throw new Error(`movement ${item.transfer} is not a plain mirror transfer`);
  }
  const wrong = mergeLeg(merge, item.side);
  if (wrong.id === item.with) {
    return { label: `transfer ${item.transfer}`, status: "done", detail: `swap ${item.side} → ${item.with}: already applied` };
  }
  const sideAccount = item.side === "out" ? transfer.from_account_id : transfer.to_account_id;
  const sibling = getLeg.get(item.with) as LegRow | undefined;
  if (!sibling) throw new Error(`transfer ${item.transfer}: sibling ${item.with} does not exist`);
  if (sibling.account_id !== sideAccount) {
    throw new Error(`transfer ${item.transfer}: sibling ${item.with} is not a single-leg row on account ${sideAccount}`);
  }
  if (sibling.currency !== "clp" || sibling.counter_amount != null || sibling.flow_kind != null) {
    throw new Error(`transfer ${item.transfer}: sibling ${item.with} is not a plain CLP leg`);
  }
  if (Math.round(sibling.amount) !== Math.round(wrong.amount_clp)) {
    throw new Error(`transfer ${item.transfer}: sibling ${item.with} amount ${sibling.amount} ≠ ${wrong.amount_clp}`);
  }
  const other = mergeLeg(merge, item.side === "out" ? "in" : "out");
  const outYmd = item.side === "out" ? sibling.occurred_on : other.occurred_on;
  const inYmd = item.side === "out" ? other.occurred_on : sibling.occurred_on;
  const outMonthPrecision = mirrorLegIsMonthPrecision(accountKindSlugForAccountId(transfer.from_account_id));
  const inMonthPrecision = mirrorLegIsMonthPrecision(accountKindSlugForAccountId(transfer.to_account_id));
  if (!outMonthPrecision && !inMonthPrecision) {
    if (inYmd < outYmd || daysBetween(outYmd, inYmd) > MIRROR_PAIR_MAX_DAY_GAP) {
      throw new Error(`transfer ${item.transfer}: sibling ${item.with} (${sibling.occurred_on}) is outside the pairing window`);
    }
  }
  assertUnreferenced(item.with, new Set(["checking_income_movement_overrides", "movement_mirror_pair_rejections"]), "sibling");
  if (sibling.units_delta && other.units_delta) {
    throw new Error(`transfer ${item.transfer}: sibling ${item.with} and the other leg both move cuotas`);
  }
  // The conversion rule: the out leg's cuotas, else the in leg's (at most one leg carries any).
  const units =
    item.side === "out" ? sibling.units_delta ?? other.units_delta : other.units_delta ?? sibling.units_delta;
  const transferUnits = units != null && Number.isFinite(units) && units !== 0 ? Math.abs(units) : null;
  const transferDate = outMonthPrecision && !inMonthPrecision ? inYmd : outYmd;

  restoreLeg(sideAccount, wrong);
  delIncomeOverride.run(item.with);
  delMovement.run(item.with);
  const p = item.side;
  db.prepare(
    `UPDATE movement_mirror_merges
     SET ${p}_movement_id = ?, ${p}_occurred_on = ?, ${p}_amount_clp = ?, ${p}_units_delta = ?, ${p}_note = ?
     WHERE transfer_movement_id = ?`
  ).run(sibling.id, sibling.occurred_on, sibling.amount, sibling.units_delta, sibling.note, item.transfer);
  db.prepare(`UPDATE movements SET occurred_on = ?, note = ?, units_delta = ? WHERE id = ?`).run(
    transferDate,
    humanNote(outYmd, inYmd),
    transferUnits,
    item.transfer
  );
  return {
    label: `transfer ${item.transfer}`,
    status: "applied",
    detail:
      `swap ${p}: restored ${wrong.id} (${wrong.occurred_on}), absorbed ${sibling.id} (${sibling.occurred_on}); ` +
      `transfer date ${transfer.occurred_on} → ${transferDate}`,
  };
}

/**
 * A current pairing the audit found is not a transfer (same shape as the undone ones, never
 * converted): recorded as a panel rejection so it is never offered again. Both legs must be
 * single-leg rows.
 */
function runReject(item: Extract<PlanItem, { action: "reject" }>): Outcome {
  const label = `reject ${item.out} → ${item.in}`;
  for (const id of [item.out, item.in]) {
    const row = getLeg.get(id) as LegRow | undefined;
    if (!row || row.account_id == null) throw new Error(`${label}: ${id} is not a single-leg movement`);
  }
  const changes = Number(insRejection.run(item.out, item.in).changes);
  return { label, status: changes > 0 ? "applied" : "done", detail: changes > 0 ? "rejection recorded" : "already rejected" };
}

/** Account/dates a plan item touches (read-only; the month-ends of these are balance-checked). */
function touchedDates(item: PlanItem): { accountId: number; ymd: string }[] {
  if (item.action === "reject") return [];
  const merge = getMerge.get(item.transfer) as MergeRow | undefined;
  const transfer = getTransfer.get(item.transfer) as TransferRow | undefined;
  if (!merge || !transfer || transfer.from_account_id == null || transfer.to_account_id == null) return [];
  const from = transfer.from_account_id;
  const to = transfer.to_account_id;
  const dates = [
    { accountId: from, ymd: transfer.occurred_on },
    { accountId: to, ymd: transfer.occurred_on },
    { accountId: from, ymd: merge.out_occurred_on },
    { accountId: to, ymd: merge.in_occurred_on },
  ];
  if (item.action === "swap") {
    const sibling = getLeg.get(item.with) as LegRow | undefined;
    if (sibling) dates.push({ accountId: item.side === "out" ? from : to, ymd: sibling.occurred_on });
  }
  return dates;
}

function monthEnd(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

type Snapshot = { balances: Map<string, number>; anchors: Map<number, ReturnType<typeof getCheckingLedgerAnchor>> };

function snapshot(checks: { accountId: number; ymd: string }[], checkingIds: number[]): Snapshot {
  const balances = new Map<string, number>();
  for (const c of checks) {
    balances.set(`${c.accountId}|${c.ymd}`, nonAnchorClpFlowTotals(c.accountId, { toYmd: c.ymd }).net_clp);
  }
  const anchors = new Map<number, ReturnType<typeof getCheckingLedgerAnchor>>();
  for (const id of checkingIds) anchors.set(id, getCheckingLedgerAnchor(id));
  return { balances, anchors };
}

const checkingIds = listMovementBalanceCashAccountIds();

db.exec("BEGIN IMMEDIATE");
try {
  // Month-ends of every date the plan touches, read before any write (the balance must not move).
  const checks = new Map<string, { accountId: number; ymd: string }>();
  for (const t of plan.flatMap(touchedDates)) {
    const ymd = monthEnd(t.ymd);
    checks.set(`${t.accountId}|${ymd}`, { accountId: t.accountId, ymd });
  }
  const checkList = [...checks.values()].sort((a, b) => a.accountId - b.accountId || a.ymd.localeCompare(b.ymd));
  const before = snapshot(checkList, checkingIds);

  const outcomes = plan.map((item) =>
    item.action === "undo" ? runUndo(item) : item.action === "swap" ? runSwap(item) : runReject(item)
  );
  for (const o of outcomes) {
    console.log(`${o.label}: ${o.status === "done" ? "DONE" : APPLY ? "APPLIED" : "WOULD APPLY"} ${o.detail}`);
  }

  const after = snapshot(checkList, checkingIds);
  let moved = 0;
  for (const c of checkList) {
    const k = `${c.accountId}|${c.ymd}`;
    if (before.balances.get(k) !== after.balances.get(k)) {
      moved++;
      console.log(`  BALANCE MOVED account ${c.accountId} at ${c.ymd}: ${before.balances.get(k)} → ${after.balances.get(k)}`);
    }
  }
  for (const id of checkingIds) {
    const b = before.anchors.get(id);
    const a = after.anchors.get(id);
    if (!b || !a) continue;
    const same = b.amount_clp === a.amount_clp && b.cartola_derived_amount_clp === a.cartola_derived_amount_clp;
    console.log(
      `  anchor account ${id}: stored ${a.amount_clp}, derived ${b.cartola_derived_amount_clp} → ` +
        `${a.cartola_derived_amount_clp}${same ? " (unchanged)" : " CHANGED"}`
    );
    if (!same) moved++;
  }
  console.log(`  checked ${checkList.length} month-end balance(s): ${moved === 0 ? "all unchanged" : `${moved} moved`}`);
  if (moved > 0) throw new Error("the repair would move balances or anchors — nothing written");

  const applied = outcomes.filter((o) => o.status === "applied").length;
  if (APPLY) {
    db.exec("COMMIT");
    console.log(
      `applied ${applied} repair(s)` + (applied > 0 ? "; restart the primary server so its in-process caches drop" : "")
    );
  } else {
    db.exec("ROLLBACK");
    console.log(`report only (${applied} pending) — rolled back; re-run with --apply to write`);
  }
} catch (e) {
  if (db.inTransaction) db.exec("ROLLBACK");
  throw e;
}
