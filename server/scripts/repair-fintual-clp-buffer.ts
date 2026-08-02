/**
 * Tranche C — fold the Fintual CLP ±10M reroute buffer into real transfers (report-first).
 *
 * The Feb-2025 caca daca → Reserva fund switch (Fintual "MLT interno") is stored as four
 * single-leg rows: cert legs m10733 (caca daca −10M / −3.345,9671 cuotas, 2025-02-10) and
 * m10734 (Reserva +10M / +7.360,8319 cuotas, 2025-02-11), plus the synthetic buffer pair
 * m11850/m11851 (`reroute:clp-buffer`) shuttling the cash through Fintual CLP. Converts to:
 *
 *   TC1  caca daca → Fintual CLP  10.000.000  3.345,9671 cuotas  2025-02-10  (merge: m10733 ↔ m11850)
 *   TC2  Fintual CLP → Reserva    10.000.000  7.360,8319 cuotas  2025-02-11  (merge: m11851 ↔ m10734)
 *
 * Balance/cuota-neutral at every date by construction (the wallet already held 10M
 * overnight); both hops are 1:1 so each carries a movement_mirror_merges row (undo +
 * original legs preserved). The fintual-cert reconcile matches transfer legs (exact
 * amount ±5 days), so re-imports stay idempotent — verified by running its report after.
 *
 * Usage (from server/):
 *   npx tsx scripts/repair-fintual-clp-buffer.ts            # report only
 *   npx tsx scripts/repair-fintual-clp-buffer.ts --apply    # write + verify + commit
 */
import { db } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const CLP_TOL = 0.5;
const UNITS_TOL = 1e-9;

type MovementRow = {
  id: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount_clp: number | null;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
};

function fail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

function accountIdByImportKey(key: string): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(key) as
    | { id: number }
    | undefined;
  if (!row) fail(`account with import_key ${key} not found`);
  return row.id;
}

const CACA_DACA = accountIdByImportKey("import:fintual|cert|key=risky_norris");
const RESERVA = accountIdByImportKey("import:fintual|cert|key=reserva2");
const FINTUAL_CLP = accountIdByImportKey("import:panel|kind=clp|key=fintual_clp");

const EXPECT: Record<number, { account: number; on: string; clp: number; units: number | null; kind: string | null }> = {
  10733: { account: CACA_DACA, on: "2025-02-10", clp: -10000000, units: -3345.9671, kind: null },
  11850: { account: FINTUAL_CLP, on: "2025-02-10", clp: 10000000, units: null, kind: "deposit_clp" },
  11851: { account: FINTUAL_CLP, on: "2025-02-11", clp: -10000000, units: null, kind: "withdrawal_clp" },
  10734: { account: RESERVA, on: "2025-02-11", clp: 10000000, units: 7360.8319, kind: null },
};
const DELETED_IDS = Object.keys(EXPECT).map(Number);

function movementById(id: number): MovementRow {
  const m = db.prepare(`SELECT * FROM movements WHERE id = ?`).get(id) as MovementRow | undefined;
  if (!m) fail(`movement ${id} not found`);
  return m;
}

function assertNoExternalRefs(ids: number[]): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'movements'`)
    .all() as { name: string }[];
  const ph = ids.map(() => "?").join(",");
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as { name: string }[];
    for (const c of cols) {
      if (!/movement_id$/i.test(c.name)) continue;
      const hit = db
        .prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t.name)} WHERE ${JSON.stringify(c.name)} IN (${ph})`)
        .get(...ids) as { n: number };
      if (hit.n > 0) fail(`${t.name}.${c.name} references ${hit.n} row(s) slated for deletion`);
    }
  }
}

function clpBalanceAt(accountId: number, ymd: string): number {
  const r = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_clp) FROM movements WHERE account_id = ? AND occurred_on <= ?), 0)
       + COALESCE((SELECT SUM(amount_clp) FROM movements WHERE to_account_id = ? AND occurred_on <= ?), 0)
       - COALESCE((SELECT SUM(amount_clp) FROM movements WHERE from_account_id = ? AND occurred_on <= ?), 0) AS bal`
    )
    .get(accountId, ymd, accountId, ymd, accountId, ymd) as { bal: number };
  return r.bal;
}

/** Fund cuota total: single-leg units + non-equity transfer legs (±abs), mirrors transferLegUnitsThroughDate. */
function fundCuotas(accountId: number): number {
  const single = db
    .prepare(`SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements WHERE account_id = ?`)
    .get(accountId) as { u: number };
  const legs = db
    .prepare(
      `SELECT from_account_id, to_account_id, units_delta, flow_kind FROM movements
       WHERE account_id IS NULL AND units_delta IS NOT NULL AND (from_account_id = ? OR to_account_id = ?)`
    )
    .all(accountId, accountId) as MovementRow[];
  let total = single.u;
  for (const r of legs) {
    if (r.flow_kind != null && ["stock_buy", "stock_sell", "compra_usd", "compra_usd_venta_clp", "dividend_usd", "dividend_payout"].includes(r.flow_kind)) continue;
    const mag = Math.abs(r.units_delta!);
    if (r.to_account_id === accountId) total += mag;
    else total -= mag;
  }
  return total;
}

const PROBES: [number, string][] = [
  [FINTUAL_CLP, "2025-02-09"],
  [FINTUAL_CLP, "2025-02-10"],
  [FINTUAL_CLP, "2025-02-11"],
  [CACA_DACA, "2025-02-09"],
  [CACA_DACA, "2025-02-10"],
  [RESERVA, "2025-02-10"],
  [RESERVA, "2025-02-11"],
  [FINTUAL_CLP, "2026-08-01"],
];

function main(): void {
  const rows = new Map<number, MovementRow>();
  for (const [idStr, e] of Object.entries(EXPECT)) {
    const id = Number(idStr);
    const m = movementById(id);
    if (m.account_id !== e.account) fail(`m${id}: account_id ${m.account_id} != ${e.account}`);
    if (m.occurred_on !== e.on) fail(`m${id}: occurred_on ${m.occurred_on} != ${e.on}`);
    if (Math.abs((m.amount_clp ?? 0) - e.clp) > CLP_TOL) fail(`m${id}: amount_clp ${m.amount_clp} != ${e.clp}`);
    if (e.units != null && Math.abs((m.units_delta ?? 0) - e.units) > UNITS_TOL) fail(`m${id}: units ${m.units_delta} != ${e.units}`);
    if ((m.flow_kind ?? null) !== e.kind) fail(`m${id}: flow_kind ${m.flow_kind} != ${e.kind}`);
    rows.set(id, m);
  }
  assertNoExternalRefs(DELETED_IDS);

  const preBalances = PROBES.map(([a, d]) => clpBalanceAt(a, d));
  const preCuotas = { caca: fundCuotas(CACA_DACA), reserva: fundCuotas(RESERVA) };

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN REPORT"} — Fintual CLP reroute buffer → real transfers (tranche C)\n`);
  console.log("  + TC1  caca daca → Fintual CLP  10.000.000  3.345,9671 cuotas  2025-02-10  (+merge m10733 ↔ m11850)");
  console.log("  + TC2  Fintual CLP → Reserva    10.000.000  7.360,8319 cuotas  2025-02-11  (+merge m11851 ↔ m10734)");
  console.log(`  − DELETE m10733, m10734, m11850, m11851\n`);
  console.log(`Pre cuotas: caca daca ${preCuotas.caca}  Reserva ${preCuotas.reserva}`);

  if (!APPLY) {
    console.log("\nReport only — no changes written. Re-run with --apply to execute.");
    return;
  }

  const insertMovement = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  );
  const insertMerge = db.prepare(
    `INSERT INTO movement_mirror_merges (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note, in_movement_id, in_occurred_on, in_amount_clp, in_units_delta, in_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    const pairs: [number, number, number, number, string, number][] = [
      // [fromAcct, toAcct, outId, inId, date, units]
      [CACA_DACA, FINTUAL_CLP, 10733, 11850, "2025-02-10", 3345.9671],
      [FINTUAL_CLP, RESERVA, 11851, 10734, "2025-02-11", 7360.8319],
    ];
    for (const [from, to, outId, inId, on, units] of pairs) {
      const out = rows.get(outId)!;
      const inn = rows.get(inId)!;
      const transferId = Number(
        insertMovement.run(
          from,
          to,
          10000000,
          on,
          `Traspaso espejo (MLT interno ${out.occurred_on} → ${inn.occurred_on})|repair:clp-buffer-fold`,
          units
        ).lastInsertRowid
      );
      insertMerge.run(
        transferId,
        out.id, out.occurred_on, out.amount_clp, out.units_delta, out.note,
        inn.id, inn.occurred_on, inn.amount_clp, inn.units_delta, inn.note
      );
    }
    const del = db.prepare(`DELETE FROM movements WHERE id = ?`);
    for (const id of DELETED_IDS) del.run(id);

    PROBES.forEach(([a, d], i) => {
      const diff = clpBalanceAt(a, d) - preBalances[i]!;
      if (Math.abs(diff) > CLP_TOL) throw new Error(`balance drift: account ${a} @ ${d}: ${diff}`);
    });
    if (Math.abs(fundCuotas(CACA_DACA) - preCuotas.caca) > UNITS_TOL) {
      throw new Error(`caca daca cuotas drifted ${preCuotas.caca} → ${fundCuotas(CACA_DACA)}`);
    }
    if (Math.abs(fundCuotas(RESERVA) - preCuotas.reserva) > UNITS_TOL) {
      throw new Error(`Reserva cuotas drifted ${preCuotas.reserva} → ${fundCuotas(RESERVA)}`);
    }
    const leftovers = db
      .prepare(`SELECT id FROM movements WHERE account_id = ?`)
      .all(FINTUAL_CLP) as { id: number }[];
    if (leftovers.length > 0) {
      throw new Error(`single-leg rows remain on Fintual CLP: ${leftovers.map((r) => r.id).join(", ")}`);
    }
  });

  run();

  console.log(`\nApplied. Post cuotas: caca daca ${fundCuotas(CACA_DACA)}  Reserva ${fundCuotas(RESERVA)}`);
  console.log("All assertions passed — committed. Follow-up: run `npm run import:fintual-cert` (report) to confirm both MLT-interno legs still reconcile.");
}

main();
