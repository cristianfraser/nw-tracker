/**
 * Tranche B — every brokerage CLP wire becomes a real transfer (report-first).
 *
 * Converts the remaining single-leg rows in brokerage cash accounts (and their checking /
 * Fintual-cert counterpart legs) into explicit transfers, so no flow lacks a counterpart:
 *
 *  B1  Dec 2024 — ONE 4.600.000 cartola wire (m6712) funded Reserva (4M, cert m10722) AND
 *      the SPY opening (600k → US$612,36, m10250). Hop through Fintual CLP so the cartola
 *      line maps 1:1:  T1 checking→Fintual CLP 4,6M (12-10) · T2 Fintual CLP→Reserva 4M +
 *      2.967,5297 cuotas (12-11, cert day) · T3 Fintual CLP→Fintual USD compra 600k/612,36
 *      (12-10). Wallet truthfully holds 4M overnight (Reserva credited next day).
 *  B2  May 2026 — Reserva sale funds OILK: T4 Reserva→Fintual CLP 3M + 2.092,7878 cuotas
 *      (05-27, cert m10777) · T5 Fintual CLP→Fintual USD compra 3M/3.353,07 (05-28, m1449).
 *  B3  Jun 2026 — T6 checking→Fintual USD compra 1,2M/1.340,25 dated 06-15 (Fintual side;
 *      cartola m11287 posted 06-16 — both dates preserved in the merge row).
 *  B4  Mar 2026 — Racional: T7 checking→Racional USD compra 50k/54,35 (03-03, merge row);
 *      T8 checking→Racional CLP 300k (03-05, hop — one cartola line m7001 funded two buys) ·
 *      T9/T10 Racional CLP→Racional USD compras 241.425/264,35 + 58.575/64,04 (03-05);
 *      T11 checking→Racional USD compra 50k/54,68 dated 03-26 (Racional credit; cartola
 *      m7006 03-25 preserved in the merge row).
 *
 * 1:1 conversions (T6, T7, T11) carry `movement_mirror_merges` rows (undo + both original
 * dates); wallet-hop legs cannot (the schema requires a real in-leg) — their provenance
 * lives in the transfer notes. Requires the transfer-aware wire matcher (sameDayWireLegs
 * reads compra transfer legs) so SPY/OILK/LIN/VEA keep face-peso `clp_wire` capital.
 *
 * Verifies before planning (exact row state, zero external refs) and asserts after apply
 * (balances per probe date except four documented one-day windows, capital sums, Reserva
 * cuotas, no single-leg rows left beyond savings_earnings + the tranche-C buffer pair).
 * Any failure rolls the whole transaction back.
 *
 * Usage (from server/):
 *   npx tsx scripts/repair-brokerage-wire-transfers.ts            # report only
 *   npx tsx scripts/repair-brokerage-wire-transfers.ts --apply    # write + verify + commit
 */
import { db } from "../src/db.js";
import { loadEquityBrokerageCapitalInflowEvents } from "../src/equityBrokerageCapitalFlows.js";
import { usdCashBalanceUsdAt } from "../src/usdCashAccounts.js";
import {
  cartolaDescriptionFromNote,
  isExcludedCheckingWithdrawal,
} from "../src/checkingDescriptionPredicates.js";

const APPLY = process.argv.includes("--apply");
const CLP_TOL = 0.5;
const USD_TOL = 1e-6;
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
  amount_usd: number | null;
  ticker: string | null;
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

const CHECKING = accountIdByImportKey("import:excel|key=cuenta_corriente");
const FINTUAL_CLP = accountIdByImportKey("import:panel|kind=clp|key=fintual_clp");
const FINTUAL_USD = accountIdByImportKey("import:panel|kind=usd|key=fintual_usd");
const RACIONAL_CLP = accountIdByImportKey("import:panel|kind=clp|key=clp");
const RACIONAL_USD = accountIdByImportKey("import:panel|kind=usd|key=usd");
const RESERVA = accountIdByImportKey("import:fintual|cert|key=reserva2");
const SPY = accountIdByImportKey("import:excel|key=spy");
const OILK = accountIdByImportKey("import:panel|ticker=OILK|key=oilk");
const LIN = accountIdByImportKey("import:panel|ticker=LIN|key=lin");
const VEA = accountIdByImportKey("import:excel|key=vea");

/** Expected current state of every row this script deletes. */
const EXPECT: Record<
  number,
  { account: number; on: string; clp: number; usd?: number; units?: number; kind?: string }
> = {
  6712: { account: CHECKING, on: "2024-12-10", clp: -4600000 },
  10722: { account: RESERVA, on: "2024-12-11", clp: 4000000, units: 2967.5297 },
  10250: { account: FINTUAL_USD, on: "2024-12-10", clp: 600000, usd: 612.36, kind: "compra_usd_venta_clp" },
  10777: { account: RESERVA, on: "2026-05-27", clp: -3000000, units: -2092.7878 },
  1449: { account: FINTUAL_USD, on: "2026-05-28", clp: 3000000, usd: 3353.07, kind: "compra_usd_venta_clp" },
  11287: { account: CHECKING, on: "2026-06-16", clp: -1200000 },
  10797: { account: FINTUAL_USD, on: "2026-06-15", clp: 1200000, usd: 1340.25, kind: "compra_usd_venta_clp" },
  6995: { account: CHECKING, on: "2026-03-03", clp: -50000 },
  10265: { account: RACIONAL_USD, on: "2026-03-03", clp: 50000, usd: 54.35, kind: "compra_usd_venta_clp" },
  7001: { account: CHECKING, on: "2026-03-05", clp: -300000 },
  11003: { account: RACIONAL_USD, on: "2026-03-05", clp: 241425, usd: 264.35, kind: "compra_usd_venta_clp" },
  11004: { account: RACIONAL_USD, on: "2026-03-05", clp: 58575, usd: 64.04, kind: "compra_usd_venta_clp" },
  7006: { account: CHECKING, on: "2026-03-25", clp: -50000 },
  10270: { account: RACIONAL_USD, on: "2026-03-26", clp: 50000, usd: 54.68, kind: "compra_usd_venta_clp" },
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

/** Signed cumulative CLP (single legs + transfer legs) through `ymd`. */
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

function usdBalanceAt(accountId: number, ymd: string): number {
  const r = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM movements WHERE account_id = ? AND occurred_on <= ? AND amount_usd IS NOT NULL), 0)
       + COALESCE((SELECT SUM(amount_usd) FROM movements WHERE to_account_id = ? AND occurred_on <= ? AND amount_usd IS NOT NULL), 0)
       - COALESCE((SELECT SUM(amount_usd) FROM movements WHERE from_account_id = ? AND occurred_on <= ? AND amount_usd IS NOT NULL), 0) AS bal`
    )
    .get(accountId, ymd, accountId, ymd, accountId, ymd) as { bal: number };
  return r.bal;
}

/** Reserva cuota total: single-leg units + non-equity transfer legs (±abs), mirrors transferLegUnitsThroughDate. */
function reservaCuotas(): number {
  const single = db
    .prepare(`SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements WHERE account_id = ?`)
    .get(RESERVA) as { u: number };
  const legs = db
    .prepare(
      `SELECT from_account_id, to_account_id, units_delta, flow_kind FROM movements
       WHERE account_id IS NULL AND units_delta IS NOT NULL AND (from_account_id = ? OR to_account_id = ?)`
    )
    .all(RESERVA, RESERVA) as MovementRow[];
  let total = single.u;
  for (const r of legs) {
    if (r.flow_kind != null && ["stock_buy", "stock_sell", "compra_usd", "compra_usd_venta_clp", "dividend_usd", "dividend_payout"].includes(r.flow_kind)) continue;
    const mag = Math.abs(r.units_delta!);
    if (r.to_account_id === RESERVA) total += mag;
    else total -= mag;
  }
  return total;
}

function capitalSum(stockId: number): number {
  const events = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
  return events.reduce((s, e) => s + e.amt, 0);
}

/** [account, unit, probe ymd, expected post − pre] — every window edge plus today. */
const TODAY = new Date().toISOString().slice(0, 10);
const PROBES: [number, "clp" | "usd", string, number][] = [
  [CHECKING, "clp", "2024-12-09", 0],
  [CHECKING, "clp", "2024-12-10", 0],
  [CHECKING, "clp", "2026-03-03", 0],
  [CHECKING, "clp", "2026-03-05", 0],
  [CHECKING, "clp", "2026-03-24", 0],
  [CHECKING, "clp", "2026-03-25", 50000],
  [CHECKING, "clp", "2026-03-26", 0],
  [CHECKING, "clp", "2026-06-14", 0],
  [CHECKING, "clp", "2026-06-15", -1200000],
  [CHECKING, "clp", "2026-06-16", 0],
  [CHECKING, "clp", TODAY, 0],
  [FINTUAL_CLP, "clp", "2024-12-09", 0],
  [FINTUAL_CLP, "clp", "2024-12-10", 4000000],
  [FINTUAL_CLP, "clp", "2024-12-11", 0],
  [FINTUAL_CLP, "clp", "2026-05-26", 0],
  [FINTUAL_CLP, "clp", "2026-05-27", 3000000],
  [FINTUAL_CLP, "clp", "2026-05-28", 0],
  [FINTUAL_CLP, "clp", TODAY, 0],
  [RACIONAL_CLP, "clp", "2026-03-04", 0],
  [RACIONAL_CLP, "clp", "2026-03-05", 0],
  [RACIONAL_CLP, "clp", TODAY, 0],
  [FINTUAL_USD, "usd", "2024-12-10", 0],
  [FINTUAL_USD, "usd", "2026-05-28", 0],
  [FINTUAL_USD, "usd", "2026-06-15", 0],
  [FINTUAL_USD, "usd", "2026-06-16", 0],
  [FINTUAL_USD, "usd", TODAY, 0],
  [RACIONAL_USD, "usd", "2026-03-03", 0],
  [RACIONAL_USD, "usd", "2026-03-05", 0],
  [RACIONAL_USD, "usd", "2026-03-25", 0],
  [RACIONAL_USD, "usd", "2026-03-26", 0],
  [RACIONAL_USD, "usd", TODAY, 0],
];

function balanceAt(account: number, unit: "clp" | "usd", ymd: string): number {
  return unit === "clp" ? clpBalanceAt(account, ymd) : usdBalanceAt(account, ymd);
}

/**
 * PRODUCTION reader (usdCashBalanceUsdAt) absolute expectations after apply — this is the
 * balance the UI shows. Runs with the note-gates removed from signedUsdDeltaForAccountMovement
 * (ships with this script): buys debit for real, wire credits are real transfer legs, and the
 * only nonzero windows are truthful dividend-cash/interest holdings.
 */
const READER_PROBES: [number, string, number][] = [
  [RACIONAL_USD, "2026-03-02", 0],
  [RACIONAL_USD, "2026-03-03", 0],
  [RACIONAL_USD, "2026-03-05", 0],
  [RACIONAL_USD, "2026-03-23", 0],
  [RACIONAL_USD, "2026-03-24", 0.54],
  [RACIONAL_USD, "2026-03-25", 0.54],
  [RACIONAL_USD, "2026-03-26", 0],
  [RACIONAL_USD, "2026-06-22", 0],
  [RACIONAL_USD, "2026-06-23", 2.13],
  [RACIONAL_USD, "2026-06-30", 2.13],
  [RACIONAL_USD, "2026-07-01", 0],
  [RACIONAL_USD, TODAY, 0],
  [FINTUAL_USD, "2024-12-10", 0],
  [FINTUAL_USD, "2025-01-31", 0],
  [FINTUAL_USD, "2026-05-28", 0],
  [FINTUAL_USD, "2026-06-15", 0],
  [FINTUAL_USD, "2026-06-16", 0],
  [FINTUAL_USD, "2026-06-30", 0.02],
  [FINTUAL_USD, "2026-07-01", 0],
  [FINTUAL_USD, TODAY, 0],
];

function main(): void {
  // ── Verify current state ────────────────────────────────────────────────────
  const rows = new Map<number, MovementRow>();
  for (const [idStr, e] of Object.entries(EXPECT)) {
    const id = Number(idStr);
    const m = movementById(id);
    if (m.account_id !== e.account) fail(`m${id}: account_id ${m.account_id} != ${e.account}`);
    if (m.occurred_on !== e.on) fail(`m${id}: occurred_on ${m.occurred_on} != ${e.on}`);
    if (Math.abs((m.amount_clp ?? 0) - e.clp) > CLP_TOL) fail(`m${id}: amount_clp ${m.amount_clp} != ${e.clp}`);
    if (e.usd != null && Math.abs((m.amount_usd ?? 0) - e.usd) > USD_TOL) fail(`m${id}: amount_usd ${m.amount_usd} != ${e.usd}`);
    if (e.units != null && Math.abs((m.units_delta ?? 0) - e.units) > UNITS_TOL) fail(`m${id}: units ${m.units_delta} != ${e.units}`);
    if (e.kind != null && m.flow_kind !== e.kind) fail(`m${id}: flow_kind ${m.flow_kind} != ${e.kind}`);
    rows.set(id, m);
  }
  assertNoExternalRefs(DELETED_IDS);

  // ── Pre metrics ─────────────────────────────────────────────────────────────
  const preBalances = PROBES.map(([a, u, d]) => balanceAt(a, u, d));
  const preCapital = new Map([SPY, OILK, LIN, VEA].map((id) => [id, capitalSum(id)]));
  const preCuotas = reservaCuotas();

  // ── Plan ────────────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN REPORT"} — brokerage wires → transfers (tranche B)\n`);
  const note = (id: number) => rows.get(id)!.note ?? "";
  type Insert = {
    label: string;
    from: number;
    to: number;
    clp: number;
    usd: number | null;
    units: number | null;
    kind: string | null;
    on: string;
    ticker: string | null;
    note: string;
    merge?: { out: MovementRow; inn: MovementRow };
  };
  const inserts: Insert[] = [
    // B1 — Dec 2024, 4.6M split wire via Fintual CLP hop
    { label: "T1  checking → Fintual CLP   4.600.000        2024-12-10", from: CHECKING, to: FINTUAL_CLP, clp: 4600000, usd: null, units: null, kind: null, on: "2024-12-10", ticker: null,
      note: `Traspaso a Fintual (4,0M → Reserva + 600k → SPY)|repair:wire-transfer|from=m6712|${note(6712)}` },
    { label: "T2  Fintual CLP → Reserva    4.000.000 +2967,5297 cuotas  2024-12-11", from: FINTUAL_CLP, to: RESERVA, clp: 4000000, usd: null, units: 2967.5297, kind: null, on: "2024-12-11", ticker: null,
      note: `repair:wire-transfer|from=m10722|${note(10722)}` },
    { label: "T3  Fintual CLP → Fintual USD  compra 600.000 → US$612,36  2024-12-10", from: FINTUAL_CLP, to: FINTUAL_USD, clp: 600000, usd: 612.36, units: null, kind: "compra_usd_venta_clp", on: "2024-12-10", ticker: "SPY",
      note: `repair:wire-transfer|from=m10250|${note(10250)}` },
    // B2 — May 2026, Reserva sale → OILK
    { label: "T4  Reserva → Fintual CLP    3.000.000 −2092,7878 cuotas  2026-05-27", from: RESERVA, to: FINTUAL_CLP, clp: 3000000, usd: null, units: 2092.7878, kind: null, on: "2026-05-27", ticker: null,
      note: `repair:wire-transfer|from=m10777|${note(10777)}` },
    { label: "T5  Fintual CLP → Fintual USD  compra 3.000.000 → US$3.353,07  2026-05-28", from: FINTUAL_CLP, to: FINTUAL_USD, clp: 3000000, usd: 3353.07, units: null, kind: "compra_usd_venta_clp", on: "2026-05-28", ticker: "OILK",
      note: `repair:wire-transfer|from=m1449|${note(1449)}` },
    // B3 — Jun 2026, 1:1 with merge row (cartola 06-16 / Fintual 06-15 both preserved)
    { label: "T6  checking → Fintual USD   compra 1.200.000 → US$1.340,25  2026-06-15 (+merge)", from: CHECKING, to: FINTUAL_USD, clp: 1200000, usd: 1340.25, units: null, kind: "compra_usd_venta_clp", on: "2026-06-15", ticker: null,
      note: "Traspaso espejo (cargo cuenta 2026-06-16 → abono Fintual USD 2026-06-15)|repair:wire-transfer",
      merge: { out: rows.get(11287)!, inn: rows.get(10797)! } },
    // B4 — Mar 2026, Racional
    { label: "T7  checking → Racional USD  compra 50.000 → US$54,35  2026-03-03 (+merge)", from: CHECKING, to: RACIONAL_USD, clp: 50000, usd: 54.35, units: null, kind: "compra_usd_venta_clp", on: "2026-03-03", ticker: "VEA",
      note: "Traspaso espejo (Transf a Racional App 2026-03-03)|repair:wire-transfer",
      merge: { out: rows.get(6995)!, inn: rows.get(10265)! } },
    { label: "T8  checking → Racional CLP  300.000          2026-03-05", from: CHECKING, to: RACIONAL_CLP, clp: 300000, usd: null, units: null, kind: null, on: "2026-03-05", ticker: null,
      note: `Traspaso a Racional (300k → dos compras USD)|repair:wire-transfer|from=m7001|${note(7001)}` },
    { label: "T9  Racional CLP → Racional USD  compra 241.425 → US$264,35  2026-03-05", from: RACIONAL_CLP, to: RACIONAL_USD, clp: 241425, usd: 264.35, units: null, kind: "compra_usd_venta_clp", on: "2026-03-05", ticker: null,
      note: `repair:wire-transfer|from=m11003|${note(11003)}` },
    { label: "T10 Racional CLP → Racional USD  compra 58.575 → US$64,04   2026-03-05", from: RACIONAL_CLP, to: RACIONAL_USD, clp: 58575, usd: 64.04, units: null, kind: "compra_usd_venta_clp", on: "2026-03-05", ticker: null,
      note: `repair:wire-transfer|from=m11004|${note(11004)}` },
    { label: "T11 checking → Racional USD  compra 50.000 → US$54,68  2026-03-26 (+merge; cartola 03-25)", from: CHECKING, to: RACIONAL_USD, clp: 50000, usd: 54.68, units: null, kind: "compra_usd_venta_clp", on: "2026-03-26", ticker: "VEA",
      note: "Traspaso espejo (cargo cuenta 2026-03-25 → abono Racional USD 2026-03-26)|repair:wire-transfer",
      merge: { out: rows.get(7006)!, inn: rows.get(10270)! } },
  ];

  for (const ins of inserts) console.log(`  + ${ins.label}`);
  console.log(`  − DELETE ${DELETED_IDS.length} rows: ${DELETED_IDS.map((i) => `m${i}`).join(", ")}\n`);

  console.log("Cartola debits being converted — current gastos-exclusion status:");
  for (const id of [6712, 6995, 7001, 7006, 11287]) {
    const d = cartolaDescriptionFromNote(rows.get(id)!.note);
    console.log(`  m${id}  ${rows.get(id)!.occurred_on}  ${String(rows.get(id)!.amount_clp).padStart(11)}  excluded-from-gastos=${isExcludedCheckingWithdrawal(d)}  «${d}»`);
  }

  console.log("\nPre capital Σ CLP:", [...preCapital.entries()].map(([id, v]) => `#${id}=${v}`).join("  "));
  console.log(`Pre Reserva cuotas: ${preCuotas}`);

  console.log("\nUI balance reader (usdCashBalanceUsdAt) — current values vs post-apply expectation:");
  for (const [account, ymd, expected] of READER_PROBES) {
    const cur = usdCashBalanceUsdAt(account, ymd);
    const name = account === RACIONAL_USD ? "Racional USD" : "Fintual USD";
    const flag = Math.abs(cur - expected) > 0.005 ? "  ← will change" : "";
    console.log(`  ${name.padEnd(13)} ${ymd}  now ${cur.toFixed(2).padStart(8)}  post ${expected.toFixed(2).padStart(6)}${flag}`);
  }

  if (!APPLY) {
    console.log("\nReport only — no changes written. Re-run with --apply to execute.");
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────────
  const insertMovement = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMerge = db.prepare(
    `INSERT INTO movement_mirror_merges (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note, in_movement_id, in_occurred_on, in_amount_clp, in_units_delta, in_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    for (const ins of inserts) {
      const transferId = Number(
        insertMovement.run(ins.from, ins.to, ins.clp, ins.on, ins.note, ins.units, ins.kind, ins.usd, ins.ticker).lastInsertRowid
      );
      if (ins.merge) {
        insertMerge.run(
          transferId,
          ins.merge.out.id, ins.merge.out.occurred_on, ins.merge.out.amount_clp, ins.merge.out.units_delta, ins.merge.out.note,
          ins.merge.inn.id, ins.merge.inn.occurred_on, ins.merge.inn.amount_clp, ins.merge.inn.units_delta, ins.merge.inn.note
        );
      }
    }
    const del = db.prepare(`DELETE FROM movements WHERE id = ?`);
    for (const id of DELETED_IDS) del.run(id);

    // ── Post assertions (throw → rollback) ──────────────────────────────────
    PROBES.forEach(([a, u, d, expected], i) => {
      const tol = u === "clp" ? CLP_TOL : USD_TOL;
      const diff = balanceAt(a, u, d) - preBalances[i]!;
      if (Math.abs(diff - expected) > tol) {
        throw new Error(`balance drift: account ${a} ${u} @ ${d}: post−pre = ${diff}, expected ${expected}`);
      }
    });
    for (const [id, pre] of preCapital) {
      const post = capitalSum(id);
      if (Math.round(post) !== Math.round(pre)) {
        throw new Error(`capital Σ drift on account ${id}: ${pre} → ${post}`);
      }
    }
    if (Math.abs(reservaCuotas() - preCuotas) > UNITS_TOL) {
      throw new Error(`Reserva cuotas drifted ${preCuotas} → ${reservaCuotas()}`);
    }
    for (const [account, ymd, expected] of READER_PROBES) {
      const got = usdCashBalanceUsdAt(account, ymd);
      if (Math.abs(got - expected) > 0.005) {
        throw new Error(`reader balance: account ${account} @ ${ymd} = ${got}, expected ${expected}`);
      }
    }
    const leftovers = db
      .prepare(
        `SELECT id, flow_kind FROM movements
         WHERE account_id IN (?, ?, ?, ?) AND id NOT IN (11850, 11851) AND COALESCE(flow_kind, '') != 'savings_earnings'`
      )
      .all(RACIONAL_USD, RACIONAL_CLP, FINTUAL_CLP, FINTUAL_USD) as { id: number }[];
    if (leftovers.length > 0) {
      throw new Error(`single-leg rows remain on brokerage cash: ${leftovers.map((r) => r.id).join(", ")}`);
    }
  });

  run();

  console.log("\nApplied. Post capital Σ CLP:", [SPY, OILK, LIN, VEA].map((id) => `#${id}=${capitalSum(id)}`).join("  "));
  console.log(`Post Reserva cuotas: ${reservaCuotas()}`);
  console.log("\nAll assertions passed — committed. Follow-up: run `npm run import:fintual-cert` (report) to confirm the Reserva legs still reconcile.");
}

main();
