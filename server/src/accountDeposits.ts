import { movementIsApvAStateBonus } from "./apvAStateBonusInference.js";
import { movementCountsAsPersonalDeposit, movementIsStateContribution } from "./depositFlowKind.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { loadEquityBrokerageCapitalSortFlows } from "./equityBrokerageCapitalFlows.js";
import { db } from "./db.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { usdCashBalanceClpAt } from "./usdCashAccounts.js";

/**
 * Canonical **external** capital for charts, “aportes netos”, rentabilidad, and “aportes acum.” (full balance):
 * signed `amount_clp` on `movements` (all external flows, including APV-A state bonus).
 *
 * Equity MTM stock accounts (post USD-cash migration): **`stock_buy` / `stock_sell`** transfer USD legs
 * converted to CLP at payment date. Legacy SPY/VEA rows still use **`deposit_clp`** / **`withdrawal_clp`**
 * on `account_id` when present.
 *
 * For charts that exclude DRIP reinvestment, use {@link loadMergedDisplayDepositInflowEvents} (“aportes propios acum.”).
 */

/** Dated CLP flow toward cumulative “aportes” (positive = in, negative = out). */
export type DepositInflowEvent = {
  occurred_on: string;
  /** CLP amount for CLP display (wire CLP or reference CLP). */
  amt: number;
  /** Native USD when known (wire or USD-reference capital). */
  amt_usd?: number | null;
  capital_kind?: "clp_wire" | "usd_reference";
};

type SortFlow = { occurred_on: string; amt: number; tie: string };

type MergedSortFlow = SortFlow & {
  amt_usd?: number | null;
  capital_kind?: DepositInflowEvent["capital_kind"];
};

const MOVEMENT_EXCLUDE_NOTE_SQL = `note IS NULL OR (
  note NOT LIKE '%|afp-modelo-prior-cuotas|%'
  AND note NOT LIKE '%|afp-orphan-cert-month|%'
  AND note NOT LIKE '%|afp-antecedentes-opening|%'
  AND note NOT LIKE '%|afp-cuotas-synthetic-trim|%'
  AND note NOT LIKE '%|afp-cuotas-website-reconcile|%'
)`;

const BROKERAGE_NON_CASH_FLOW_KINDS = new Set([
  "compra_usd",
  "compra_usd_venta_clp",
  "stock_buy",
  "stock_sell",
  "dividend_usd",
]);

/** Bank-paid yield (Abonos / Intereses) on cuenta_ahorro_vivienda — P/L, not personal capital. */
export const SAVINGS_EARNINGS_FLOW_KIND = "savings_earnings";

/** Equity MTM accounts — ignore legacy Table 1-3 `dep_stocks` rows without `flow_kind`. */
function equityMtmAccountIdsSet(accountIds: number[]): Set<number> {
  return new Set(accountIds.filter((id) => id > 0 && accountUsesEquityMtm(id)));
}

function loadMovementSignedFlowEvents(
  accountIds: number[],
  personalOnly: boolean
): Map<number, SortFlow[]> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  if (uniq.length === 0) return new Map();
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, id, note, flow_kind
       FROM movements
       WHERE account_id IN (${ph})
         AND (${MOVEMENT_EXCLUDE_NOTE_SQL})
       ORDER BY account_id, occurred_on, id`
    )
    .all(...uniq) as {
    account_id: number;
    occurred_on: string;
    amount_clp: number;
    id: number;
    note: string | null;
    flow_kind: string | null;
  }[];
  const equityMtmIds = equityMtmAccountIdsSet(uniq);
  const usdCashIds = new Set(uniq.filter((id) => isUsdCashAccount(id)));
  const map = new Map<number, SortFlow[]>();
  for (const r of rows) {
    // CLP deposit_clp wires on USD cash are FX staging legs; capital lives on equity accounts.
    if (usdCashIds.has(r.account_id)) continue;
    if (equityMtmIds.has(r.account_id) && r.flow_kind == null) continue;
    if (r.flow_kind != null && BROKERAGE_NON_CASH_FLOW_KINDS.has(r.flow_kind)) continue;
    if (r.flow_kind === SAVINGS_EARNINGS_FLOW_KIND) continue;
    if (personalOnly) {
      if (
        movementIsStateContribution(r.note) ||
        movementIsApvAStateBonus(r.account_id, r.id, r.note)
      ) {
        continue;
      }
      const brokerageDeposit = r.flow_kind === "deposit_clp";
      if (!brokerageDeposit && !movementCountsAsPersonalDeposit(r.note)) continue;
    }
    if (r.note?.includes("cripto-coin-only-wdw")) continue;
    const amt = r.amount_clp;
    if (amt === 0 || !Number.isFinite(amt)) continue;
    if (!map.has(r.account_id)) map.set(r.account_id, []);
    map.get(r.account_id)!.push({ occurred_on: r.occurred_on, amt, tie: `m:${r.id}` });
  }
  return map;
}

function buildMergedDepositMap(
  accountIds: number[],
  personalOnly: boolean
): Map<number, DepositInflowEvent[]> {
  const requested = new Set(accountIds.filter((id) => id > 0));
  const mov = loadMovementSignedFlowEvents(accountIds, personalOnly);
  const equityCap = loadEquityBrokerageCapitalSortFlows(accountIds, personalOnly);
  const ids = new Set<number>([...mov.keys(), ...equityCap.keys(), ...requested]);
  const out = new Map<number, DepositInflowEvent[]>();
  for (const id of ids) {
    const movFlows: MergedSortFlow[] = (mov.get(id) ?? []).map((f) => ({ ...f }));
    const eqFlows: MergedSortFlow[] = (equityCap.get(id) ?? []).map((f) => ({
      occurred_on: f.occurred_on,
      amt: f.amt,
      tie: f.tie,
      amt_usd: f.amt_usd,
      capital_kind: f.capital_kind,
    }));
    const merged = [...movFlows, ...eqFlows].filter((e) => e.amt !== 0 && Number.isFinite(e.amt));
    merged.sort((x, y) => x.occurred_on.localeCompare(y.occurred_on) || x.tie.localeCompare(y.tie));
    out.set(
      id,
      merged.map((f) => ({
        occurred_on: f.occurred_on,
        amt: f.amt,
        ...(f.amt_usd != null && Number.isFinite(f.amt_usd) ? { amt_usd: f.amt_usd } : {}),
        ...(f.capital_kind ? { capital_kind: f.capital_kind } : {}),
      }))
    );
  }
  return out;
}

/** Full external capital (includes state APV-A bonus when tagged). */
export function loadMergedDepositInflowEvents(accountIds: number[]): Map<number, DepositInflowEvent[]> {
  return buildMergedDepositMap(accountIds, false);
}

/** Personal capital only (`deposit_clp` + `traspaso_bonificacion_clp`; excludes `aporte_estatal_clp`). */
export function loadMergedDisplayDepositInflowEvents(
  accountIds: number[]
): Map<number, DepositInflowEvent[]> {
  return buildMergedDepositMap(accountIds, true);
}

/** Same merged timeline as charts; use for audits and “Historial de aportes”. */
export function getMergedDepositInflowEventsForAccount(accountId: number): DepositInflowEvent[] {
  if (!Number.isFinite(accountId) || accountId <= 0) return [];
  return loadMergedDepositInflowEvents([accountId]).get(accountId) ?? [];
}

export function getMergedDisplayDepositInflowEventsForAccount(accountId: number): DepositInflowEvent[] {
  if (!Number.isFinite(accountId) || accountId <= 0) return [];
  return loadMergedDisplayDepositInflowEvents([accountId]).get(accountId) ?? [];
}

function loadStateContributionMovementEvents(accountIds: number[]): Map<number, SortFlow[]> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  if (uniq.length === 0) return new Map();
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, id, note
       FROM movements
       WHERE account_id IN (${ph})
         AND amount_clp > 0
       ORDER BY account_id, occurred_on, id`
    )
    .all(...uniq) as {
    account_id: number;
    occurred_on: string;
    amount_clp: number;
    id: number;
    note: string | null;
  }[];
  const map = new Map<number, SortFlow[]>();
  for (const r of rows) {
    if (!movementIsStateContribution(r.note) && !movementIsApvAStateBonus(r.account_id, r.id, r.note)) continue;
    if (!map.has(r.account_id)) map.set(r.account_id, []);
    map.get(r.account_id)!.push({ occurred_on: r.occurred_on, amt: r.amount_clp, tie: `m:${r.id}` });
  }
  return map;
}

/** APV-A state bonus rows (informational; included in full deposit totals). */
export function getStateContributionInflowEventsForAccount(accountId: number): DepositInflowEvent[] {
  if (!Number.isFinite(accountId) || accountId <= 0) return [];
  const flows = loadStateContributionMovementEvents([accountId]).get(accountId) ?? [];
  flows.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.tie.localeCompare(b.tie));
  return flows.map(({ occurred_on, amt }) => ({ occurred_on, amt }));
}

export function totalStateContributionsClpForAccount(accountId: number): number {
  return getStateContributionInflowEventsForAccount(accountId).reduce((s, e) => s + e.amt, 0);
}

/** Net external CLP capital (movements); same sum as chart cumulative end-state. */
export function totalDepositsClpForAccount(accountId: number): number {
  if (isUsdCashAccount(accountId)) {
    return usdCashBalanceClpAt(accountId, chileCalendarTodayYmd());
  }
  return getMergedDepositInflowEventsForAccount(accountId).reduce((s, e) => s + e.amt, 0);
}

export function totalDisplayDepositsClpForAccount(accountId: number): number {
  if (isUsdCashAccount(accountId)) {
    return usdCashBalanceClpAt(accountId, chileCalendarTodayYmd());
  }
  return getMergedDisplayDepositInflowEventsForAccount(accountId).reduce((s, e) => s + e.amt, 0);
}

const wdwSumStmt = db.prepare(
  `SELECT COALESCE(SUM(ABS(amount_clp)), 0) AS s FROM movements WHERE account_id = ? AND amount_clp < 0`
);

export function totalWithdrawalsClpForAccount(accountId: number): number {
  return (wdwSumStmt.get(accountId) as { s: number }).s;
}
