/**
 * List cuenta_ahorro_vivienda Depósitos and set per-deposit self-funded vs family-funded splits.
 *
 * The account holds only monthly aggregates. Some Depósitos were funded by the user (self, from
 * checking → gets a synthetic checking_internal_transfer mirror for the self amount) and some by
 * family (external, no own-account outflow). `self_funded_clp` is the user's portion; the rest is
 * family. self = full amount → fully self-funded; self = 0 → fully family (reconciled, no mirror).
 *
 *   npm run propose:cuenta-ahorro-splits -w nw-tracker-server                 # dry run: list Depósitos
 *   npm run propose:cuenta-ahorro-splits -w nw-tracker-server -- --apply \
 *       --set <movementId>=<selfClp> [--set <movementId>=<selfClp> ...]
 */
import { db } from "../src/db.js";
import { accountKindSlugForAccountId } from "../src/accountBucket.js";
import {
  syncCuentaAhorroDepositSplitMirrors,
  upsertCuentaAhorroDepositSplit,
} from "../src/cuentaAhorroDepositSplits.js";
import { buildFlowsCreditCardExpensesPayload } from "../src/flowsCreditCardExpenses.js";

const AHORRO_KIND_SLUG = "cuenta_ahorro_vivienda";

function formatClp(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}

type AhorroDepositRow = {
  movement_id: number;
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  self_funded_clp: number | null;
};

function loadAhorroDeposits(): AhorroDepositRow[] {
  const rows = db
    .prepare(
      `SELECT m.id AS movement_id, m.account_id, m.occurred_on, m.amount_clp, s.self_funded_clp
       FROM movements m
       LEFT JOIN cuenta_ahorro_deposit_splits s ON s.deposit_movement_id = m.id
       WHERE m.amount_clp > 0
         AND (m.note LIKE '%|Depósitos' OR m.note LIKE '%|Depósitos|forensic:%')
       ORDER BY m.occurred_on DESC, m.id`
    )
    .all() as AhorroDepositRow[];
  return rows.filter((r) => accountKindSlugForAccountId(r.account_id) === AHORRO_KIND_SLUG);
}

function splitLabel(row: AhorroDepositRow): string {
  if (row.self_funded_clp == null) return "(sin split)";
  const family = Math.round(row.amount_clp) - Math.round(row.self_funded_clp);
  return `self ${formatClp(row.self_funded_clp)} / family ${formatClp(family)}`;
}

function parseSetArgs(): Map<number, number> {
  const out = new Map<number, number>();
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--set") continue;
    const spec = argv[i + 1];
    if (!spec || !spec.includes("=")) {
      throw new Error(`--set expects <movementId>=<selfClp>, got: ${spec ?? "(missing)"}`);
    }
    const [idStr, selfStr] = spec.split("=");
    const movementId = Number(idStr);
    const selfClp = Number(selfStr);
    if (!Number.isInteger(movementId) || !Number.isFinite(selfClp)) {
      throw new Error(`--set invalid values: ${spec}`);
    }
    out.set(movementId, Math.round(selfClp));
  }
  return out;
}

function printDeposits(rows: AhorroDepositRow[]) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`cuenta_ahorro_vivienda Depósitos: ${rows.length} | Total CLP: ${formatClp(rows.reduce((s, r) => s + r.amount_clp, 0))}`);
  console.log("Set self-funded portion per movement; the rest is treated as family (external).");
  console.log("=".repeat(78));
  console.log(`${"mov".padStart(6)}  ${"date".padEnd(12)} ${"amount".padStart(14)}   split`);
  for (const r of rows) {
    console.log(
      `${String(r.movement_id).padStart(6)}  ${r.occurred_on.padEnd(12)} ${formatClp(r.amount_clp).padStart(14)}   ${splitLabel(r)}`
    );
  }
}

/** Exact checking outflow (cuenta_corriente / cuenta_vista) of the same amount within ±5 days. */
function hasExactCartolaOutflow(amountClp: number, occurredOn: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM movements
       WHERE account_id IN (SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
                            WHERE g.slug LIKE '%cuenta_corriente%' OR g.slug LIKE '%cuenta_vista%')
         AND amount_clp < 0 AND ABS(amount_clp) = ?
         AND ABS(julianday(occurred_on) - julianday(?)) <= 5
       LIMIT 1`
    )
    .get(Math.round(amountClp), occurredOn);
  return row != null;
}

/** Parse `--family-default <pct>`: percent assumed family-funded when no exact cartola outflow. */
function parseFamilyDefaultPct(): number | null {
  const i = process.argv.indexOf("--family-default");
  if (i < 0) return null;
  const pct = Number(process.argv[i + 1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`--family-default expects a percent 0..100, got: ${process.argv[i + 1]}`);
  }
  return pct;
}

function main() {
  const apply = process.argv.includes("--apply");
  const rows = loadAhorroDeposits();
  printDeposits(rows);

  if (!apply) {
    console.log("\nDone. No changes. Pass --apply --set <movementId>=<selfClp> to record splits,");
    console.log("or --apply --family-default 90 to assume 90% family / 10% self where no exact cartola outflow exists.");
    return;
  }

  const assignments = parseSetArgs();
  const familyDefaultPct = parseFamilyDefaultPct();
  if (familyDefaultPct != null) {
    // Fill every un-split deposit: full self when an exact cartola outflow exists (clearly self-funded),
    // else self = (100 − pct)% (the rest assumed family). Explicit --set entries still take precedence.
    for (const r of rows) {
      if (r.self_funded_clp != null) continue;
      if (assignments.has(r.movement_id)) continue;
      const self = hasExactCartolaOutflow(r.amount_clp, r.occurred_on)
        ? Math.round(r.amount_clp)
        : Math.round(r.amount_clp * (100 - familyDefaultPct) / 100);
      assignments.set(r.movement_id, self);
    }
  }
  if (assignments.size === 0) {
    console.log("\n--apply given but no --set / --family-default assignments; nothing to do.");
    return;
  }

  let n = 0;
  const tx = db.transaction(() => {
    for (const [movementId, selfClp] of assignments) {
      upsertCuentaAhorroDepositSplit(movementId, selfClp, "propose:cuenta-ahorro-splits");
      n += 1;
    }
  });
  tx();

  // Materialize the self-funded portions as mirrors, then rebuild links so reconciliation reflects it.
  syncCuentaAhorroDepositSplitMirrors();
  buildFlowsCreditCardExpensesPayload();
  console.log(`\nApply: recorded ${n} split(s). Mirrors + links re-synced.`);
}

main();
