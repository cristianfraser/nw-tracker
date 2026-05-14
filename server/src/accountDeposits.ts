import { readSpyVeaDepositadoClpFromStocksCsv } from "./accountPosition.js";
import { db } from "./db.js";

/**
 * Canonical **external** capital for charts, “aportes netos”, and “aportes acum.”:
 * - `movements`: signed `amount_clp` (user transfers).
 * - `brokerage_flows`: only **`deposit_clp`** as positive inflow; **`withdrawal_clp`** as outflow.
 *
 * **`compra_usd`** and **`dividend_usd`** are not new cash from outside the account (DRIP, divs in caja, buys from
 * existing USD) — they do **not** enter this series. They remain in the Bolsa table and drive **stock inflows** via
 * `units_delta` where applicable.
 */

/** Dated CLP flow toward cumulative “aportes” (positive = in, negative = out). */
export type DepositInflowEvent = { occurred_on: string; amt: number };

type SortFlow = { occurred_on: string; amt: number; tie: string };

function loadMovementSignedFlowEvents(accountIds: number[]): Map<number, SortFlow[]> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  if (uniq.length === 0) return new Map();
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, id
       FROM movements
       WHERE account_id IN (${ph})
       ORDER BY account_id, occurred_on, id`
    )
    .all(...uniq) as {
    account_id: number;
    occurred_on: string;
    amount_clp: number;
    id: number;
  }[];
  const map = new Map<number, SortFlow[]>();
  for (const r of rows) {
    const amt = r.amount_clp;
    if (amt === 0 || !Number.isFinite(amt)) continue;
    if (!map.has(r.account_id)) map.set(r.account_id, []);
    map.get(r.account_id)!.push({ occurred_on: r.occurred_on, amt, tie: `m:${r.id}` });
  }
  return map;
}

/** Brokerage CLP wires only (not compra/dividend USD). */
function loadBrokerageInflowEvents(accountIds: number[]): Map<number, SortFlow[]> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  if (uniq.length === 0) return new Map();
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, id
       FROM brokerage_flows
       WHERE account_id IN (${ph})
         AND flow_kind = 'deposit_clp'
         AND COALESCE(amount_clp, 0) > 0
       ORDER BY account_id, occurred_on, id`
    )
    .all(...uniq) as {
    account_id: number;
    occurred_on: string;
    amount_clp: number;
    id: number;
  }[];
  const map = new Map<number, SortFlow[]>();
  for (const r of rows) {
    if (!map.has(r.account_id)) map.set(r.account_id, []);
    map.get(r.account_id)!.push({
      occurred_on: r.occurred_on,
      amt: r.amount_clp,
      tie: `b+:${r.id}`,
    });
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.tie.localeCompare(b.tie));
  }
  return map;
}

function loadBrokerageWithdrawalFlowEvents(accountIds: number[]): Map<number, SortFlow[]> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  if (uniq.length === 0) return new Map();
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, id
       FROM brokerage_flows
       WHERE account_id IN (${ph})
         AND flow_kind = 'withdrawal_clp'
         AND COALESCE(amount_clp, 0) > 0
       ORDER BY account_id, occurred_on, id`
    )
    .all(...uniq) as { account_id: number; occurred_on: string; amount_clp: number; id: number }[];
  const map = new Map<number, SortFlow[]>();
  for (const r of rows) {
    if (!map.has(r.account_id)) map.set(r.account_id, []);
    map.get(r.account_id)!.push({
      occurred_on: r.occurred_on,
      amt: -r.amount_clp,
      tie: `b-:${r.id}`,
    });
  }
  return map;
}

function mergeSortFlows(a: SortFlow[], b: SortFlow[], c: SortFlow[]): DepositInflowEvent[] {
  const merged = [...a, ...b, ...c].filter((e) => e.amt !== 0 && Number.isFinite(e.amt));
  merged.sort((x, y) => x.occurred_on.localeCompare(y.occurred_on) || x.tie.localeCompare(y.tie));
  return merged.map(({ occurred_on, amt }) => ({ occurred_on, amt }));
}

/** Movements (signed) + bolsa `deposit_clp` inflows and `withdrawal_clp` (signed), sorted for cumulative charts. */
export function loadMergedDepositInflowEvents(accountIds: number[]): Map<number, DepositInflowEvent[]> {
  const requested = new Set(accountIds.filter((id) => id > 0));
  const mov = loadMovementSignedFlowEvents(accountIds);
  const brkIn = loadBrokerageInflowEvents(accountIds);
  const brkOut = loadBrokerageWithdrawalFlowEvents(accountIds);
  const ids = new Set<number>([...mov.keys(), ...brkIn.keys(), ...brkOut.keys(), ...requested]);
  const out = new Map<number, DepositInflowEvent[]>();
  for (const id of ids) {
    out.set(id, mergeSortFlows(mov.get(id) ?? [], brkIn.get(id) ?? [], brkOut.get(id) ?? []));
  }
  return out;
}

/** Same merged timeline as charts; use for audits and “Historial de aportes”. */
export function getMergedDepositInflowEventsForAccount(accountId: number): DepositInflowEvent[] {
  if (!Number.isFinite(accountId) || accountId <= 0) return [];
  return loadMergedDepositInflowEvents([accountId]).get(accountId) ?? [];
}

/** Net external CLP capital (movements + CLP wires − withdrawals); same sum as chart cumulative end-state. */
export function totalDepositsClpForAccount(accountId: number): number {
  return getMergedDepositInflowEventsForAccount(accountId).reduce((s, e) => s + e.amt, 0);
}

/**
 * Same as {@link totalDepositsClpForAccount} but for SPY/VEA never below the Numbers **`depositado`** cell in
 * `net worth-stocks.csv` (import used to skip row 1; DB can lack the main CLP wire while the sheet is correct).
 */
export function totalDepositsClpWithStocksSheetFloor(accountId: number, categorySlug: string): number {
  const base = totalDepositsClpForAccount(accountId);
  if (categorySlug !== "spy" && categorySlug !== "vea") return base;
  const slug = categorySlug === "spy" ? "spy" : "vea";
  const sheet = readSpyVeaDepositadoClpFromStocksCsv(slug);
  if (sheet == null || sheet <= 0) return base;
  return Math.max(base, sheet);
}

const movWdwSumStmt = db.prepare(
  `SELECT COALESCE(SUM(ABS(amount_clp)), 0) AS s FROM movements WHERE account_id = ? AND amount_clp < 0`
);
const brkWdwSumStmt = db.prepare(
  `SELECT COALESCE(SUM(amount_clp), 0) AS s FROM brokerage_flows WHERE account_id = ? AND flow_kind = 'withdrawal_clp'`
);

export function totalWithdrawalsClpForAccount(accountId: number): number {
  const mov = (movWdwSumStmt.get(accountId) as { s: number }).s;
  const brk = (brkWdwSumStmt.get(accountId) as { s: number }).s;
  return mov + brk;
}
