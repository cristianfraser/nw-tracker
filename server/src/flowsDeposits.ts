import { accountBucketKindSlug } from "./accountBucket.js";
import { PAYROLL_FUNDED_KINDS } from "./accountProfile.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadMergedDisplayDepositInflowEvents } from "./accountDeposits.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { densifyMonthlyPoints, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import {
  clearFxConversionWarnings,
  takeFxConversionWarnings,
  type FxConversionWarning,
} from "./fxConversionWarnings.js";
import { accountIdsUnderCheckingAccounts } from "./movementBalanceCashAccounts.js";
import type { MortgageCarryingEvent } from "./flowsMortgageCarrying.js";
import {
  deptoPropertyPaymentEventsThroughDate,
  mortgageSheetPaymentEventsThroughDate,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { flowEventInUnit, type TsUnit } from "./rates.js";
import { windowIndexOf } from "./perfKernel.js";

/**
 * The depto ledger's payments as flows in `unit` through `throughYmd`, each at its own day's rate
 * (`flowEventInUnit`), zero payments left out: the mortgage's cuotas and prepagos (`loan`), or
 * every payment into the property (`property`). The one place both the daily series and the
 * monthly rows read them.
 */
export function deptoPaymentFlowsInUnit(
  ledger: readonly DeptoMortgageSheetRow[],
  throughYmd: string,
  leg: "loan" | "property",
  unit: TsUnit
): { occurred_on: string; amount: number }[] {
  const events =
    leg === "loan"
      ? mortgageSheetPaymentEventsThroughDate(ledger, throughYmd)
      : deptoPropertyPaymentEventsThroughDate(ledger, throughYmd);
  const out: { occurred_on: string; amount: number }[] = [];
  for (const e of events) {
    if (e.pago_clp === 0) continue;
    out.push({ occurred_on: e.occurred_on, amount: flowEventInUnit({ occurred_on: e.occurred_on, amt: e.pago_clp }, unit) });
  }
  return out;
}

/** Big-category buckets for the flows → deposits page (matches sidebar groupings). */
export const DEPOSIT_FLOW_CATEGORIES = ["real_estate", "cash", "brokerage", "inversiones"] as const;
export type DepositFlowCategory = (typeof DEPOSIT_FLOW_CATEGORIES)[number];

export function depositFlowCategoryFromGroupSlug(groupSlug: string): DepositFlowCategory | null {
  if (groupSlug === "real_estate") return "real_estate";
  if (groupSlug === "cash_eqs") return "cash";
  if (groupSlug === "brokerage") return "brokerage";
  if (groupSlug === "retirement") return "inversiones";
  return null;
}

export type FlowDepositRow = {
  /** Display date (bank date, or today for a forward-posted movement — see `posted_on`). */
  occurred_on: string;
  /** Bank posting date when it lies after today: listed under today, already counted. */
  posted_on?: string;
  category: DepositFlowCategory;
  account_id: number;
  account_name: string;
  /** Account behavior kind (`afp`, `afc`, `cuenta_corriente`, …) — see accountBucketKindSlug. */
  kind_slug: string;
  /** The event's pesos, unrounded (the pre-tax and pension switch rules read them; never on the wire). */
  amount_clp: number;
  /** The event in the rows' unit at its own date's rate ({@link flowEventInUnit}), unrounded. */
  amount: number;
  /**
   * The mortgage carrying (interés + seguros) the property's dividendo deposit records, taken back
   * out (negative): it is a gasto, so the deposit counts the amortización only (the /flows/deposits
   * page, `withMortgageCarrying`).
   */
  mortgage_carrying?: true;
  /**
   * One leg of a switch between two pension funds (an `afp_fund_switch` transfer: the same pesos out
   * of one AFP/AFC account and into another, the same day). Both legs are pre-tax, so they cancel
   * there instead of reading as a withdrawal and a cotización.
   */
  pension_switch?: true;
};


/**
 * An AFP/AFC cotización (a positive pension event): payroll-deducted, shown apart from the
 * post-tax deposits by the flows overview and the /flows/deposits page. A negative one (a retiro
 * that reached checking) is an ordinary deposit row.
 */
export function isPreTaxDepositRow(row: Pick<FlowDepositRow, "kind_slug" | "amount_clp" | "pension_switch">): boolean {
  if (row.pension_switch) return true;
  return PAYROLL_FUNDED_KINDS.has(row.kind_slug) && row.amount_clp > 0;
}

/**
 * Marks the two legs of each pension fund switch: a negative and a positive AFP/AFC row of the same
 * day and the same pesos on two different accounts (the transfer's legs; one-to-one).
 */
export function markPensionSwitchRows(
  rows: Pick<FlowDepositRow, "kind_slug" | "amount_clp" | "account_id" | "occurred_on" | "pension_switch">[]
): void {
  const pension = rows.filter((r) => PAYROLL_FUNDED_KINDS.has(r.kind_slug) && !r.pension_switch);
  const used = new Set<(typeof rows)[number]>();
  for (const out of pension) {
    if (out.amount_clp >= 0 || used.has(out)) continue;
    const into = pension.find(
      (r) =>
        !used.has(r) &&
        r.amount_clp > 0 &&
        r.account_id !== out.account_id &&
        r.occurred_on === out.occurred_on &&
        Math.abs(r.amount_clp + out.amount_clp) < 0.5
    );
    if (!into) continue;
    used.add(out);
    used.add(into);
    out.pension_switch = true;
    into.pension_switch = true;
  }
}

export type FlowDepositChartPoint = {
  as_of_date: string;
  real_estate: number;
  cash: number;
  brokerage: number;
  inversiones: number;
  total: number;
};

export type DepositFlowAccountRow = {
  account_id: number;
  name: string;
  group_slug: string;
  category_slug: string;
};

export function listDepositFlowAccounts(includeExcludedFromGroupTotals = false): DepositFlowAccountRow[] {
  const excludedClause = includeExcludedFromGroupTotals
    ? ""
    : "AND COALESCE(a.exclude_from_group_totals, 0) = 0";
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (a.import_key IS NULL OR a.import_key != ?)
        ${excludedClause}
         AND g.slug != 'individual_stocks'
       ORDER BY g.sort_order, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as { account_id: number; name: string; bucket_slug: string }[];
  return rows
    .map((r) => {
      const group_slug = dashboardBucketForAssetGroupSlug(r.bucket_slug);
      if (!group_slug || !["real_estate", "cash_eqs", "brokerage", "retirement"].includes(group_slug)) {
        return null;
      }
      return {
        account_id: r.account_id,
        name: r.name,
        group_slug,
        category_slug: accountBucketKindSlug(r.bucket_slug),
      };
    })
    .filter((r): r is DepositFlowAccountRow => r != null);
}

function monthEndFromOccurredOn(occurredOn: string): string {
  const mk = monthKeyFromYmd(occurredOn);
  return mk ? monthEndUtcYmd(mk) : occurredOn;
}

function flowsDepositsNetTotalsByAccount(
  unit: TsUnit,
  opts?: { period?: "month" | "year"; includeExcludedFromGroupTotals?: boolean }
): Map<number, number> {
  const accounts = listDepositFlowAccounts(opts?.includeExcludedFromGroupTotals ?? false);
  const ids = accounts.map((a) => a.account_id);
  const eventsByAccount = loadMergedDisplayDepositInflowEvents(ids);
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);
  const currentY = today.slice(0, 4);
  const totals = new Map<number, number>();
  for (const acc of accounts) {
    const events = eventsByAccount.get(acc.account_id) ?? [];
    let sum = 0;
    for (const e of events) {
      if (e.amt === 0) continue;
      if (opts?.period === "month" && monthKeyFromYmd(e.occurred_on) !== currentMk) continue;
      if (opts?.period === "year" && e.occurred_on.slice(0, 4) !== currentY) continue;
      // Events are display-dated: a forward-posted movement already reads as today, which is
      // also where the balances count it (`displayLedgerCutoffYmd`), so lifetime P/L
      // (delta_total = value − deposits) stays clean without a cap here.
      sum += flowEventInUnit(e, unit);
    }
    totals.set(acc.account_id, sum);
  }
  return totals;
}

/**
 * Net capital flow for one account over the half-open window `(startYmd, endYmd]`, in `unit`.
 * Sums merged deposit-inflow events in the window (same event source as the monthly builder,
 * so short-horizon returns flow-adjust identically to MTD) — USD-cash accounts included since
 * 2026-08-04: their events come from `loadForeignCashCapitalSortFlows` (native USD legs, per-event
 * CLP conversion), so a window with no events reads 0 in both frames instead of leaking fx
 * drift on the standing balance. Callers pass the window's prior anchor as `startYmd`
 * (exclusive) and the reference date as `endYmd` (inclusive).
 */
export function netDepositFlowBetween(
  accountId: number,
  startYmd: string,
  endYmd: string,
  unit: TsUnit
): number {
  return netDepositFlowWindows(accountId, unit)(startYmd, endYmd);
}

/**
 * {@link netDepositFlowBetween} over many windows of one account: the merged events load once,
 * then each call sums the events in its window `(startYmd, endYmd]`, each converted at its own
 * day's rate (`flowEventInUnit`) — in UF too, never the window's peso sum at the window end.
 */
export function netDepositFlowWindows(
  accountId: number,
  unit: TsUnit
): (startYmd: string, endYmd: string) => number {
  const events = loadMergedDisplayDepositInflowEvents([accountId]).get(accountId) ?? [];
  return (startYmd, endYmd) => {
    const window = [startYmd, endYmd];
    let sum = 0;
    for (const e of events) {
      if (e.amt === 0) continue;
      if (windowIndexOf(window, e.occurred_on) !== 0) continue;
      sum += flowEventInUnit(e, unit);
    }
    return sum;
  };
}

/**
 * Net capital flow for one account in the current calendar month through Chile today. The
 * events are display-dated, so a movement the bank posts later is already in today's
 * bucket — the same place the live balance counts it. Same event source as
 * the dashboard deposits column, so live current-month P/L reconciles with it.
 */
export function netDepositFlowCurrentMonthThroughToday(
  accountId: number,
  unit: TsUnit
): number {
  const today = chileCalendarTodayYmd();
  return netDepositFlowBetween(accountId, priorPeriodEndYmd("mtd", today), today, unit);
}

/** Net capital (deposits − withdrawals) per account — same accounts as the flows deposits page. */
export function flowsDepositsNetTotalByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount("clp", { includeExcludedFromGroupTotals: true });
}

/** Net deposits per account in USD (each event at its own date's rate — `flowEventInUnit`). */
export function flowsDepositsNetTotalUsdByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount("usd", { includeExcludedFromGroupTotals: true });
}

/**
 * @heavy The deposit rows of the deposit-flow accounts, each event in `unit` at its own day's rate
 * (`flowEventInUnit`), newest first. `amount_clp` is the event's pesos (the pre-tax and pension
 * switch rules read it). `excludeCheckingAccounts` (the /flows/deposits page, 2026-10-27) leaves
 * out the accounts under Checking accounts: their events are cash moving in and out of the
 * checking ledger, not deposits, so the page's total is the flows overview's deposits. The
 * dashboard and the flows overview keep every account (the overview drops the checking rows
 * itself, and takes the mortgage carrying out on its own).
 *
 * `withMortgageCarrying` adds the carrying as negative rows on the property (`mortgage_carrying`)
 * so its deposits read amortización only — the flows overview's rule; then the total is the
 * overview's deposits + deposits_pre_tax. Its events must pair one-to-one by deposit movement:
 * the pesos (`clp`, which pair the events) and the unit's (`unit`).
 */
export function flowDepositRowsInUnit(
  unit: TsUnit,
  opts?: {
    excludeCheckingAccounts?: boolean;
    withMortgageCarrying?: { clp: readonly MortgageCarryingEvent[]; unit: readonly MortgageCarryingEvent[] };
  }
): FlowDepositRow[] {
  const checking = opts?.excludeCheckingAccounts ? new Set(accountIdsUnderCheckingAccounts()) : null;
  const accounts = listDepositFlowAccounts(false).filter((a) => checking == null || !checking.has(a.account_id));
  const eventsByAccount = loadMergedDisplayDepositInflowEvents(accounts.map((a) => a.account_id));
  const rows: FlowDepositRow[] = [];
  for (const acc of accounts) {
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) continue;
    for (const e of eventsByAccount.get(acc.account_id) ?? []) {
      if (e.amt === 0) continue;
      rows.push({
        occurred_on: e.occurred_on,
        ...(e.posted_on ? { posted_on: e.posted_on } : {}),
        category,
        account_id: acc.account_id,
        account_name: acc.name,
        kind_slug: acc.category_slug,
        amount_clp: flowEventInUnit(e, "clp"),
        amount: flowEventInUnit(e, unit),
      });
    }
  }
  markPensionSwitchRows(rows);
  if (opts?.withMortgageCarrying) rows.push(...mortgageCarryingRows(opts.withMortgageCarrying, accounts));
  rows.sort((a, b) => {
    const d = b.occurred_on.localeCompare(a.occurred_on);
    return d !== 0 ? d : a.account_name.localeCompare(b.account_name);
  });
  return rows;
}

/**
 * One negative row per carrying event, on the property account its deposit belongs to: its pesos
 * (`amount_clp`) and its value in the rows' unit (`amount`).
 */
function mortgageCarryingRows(
  carrying: { clp: readonly MortgageCarryingEvent[]; unit: readonly MortgageCarryingEvent[] },
  accounts: readonly DepositFlowAccountRow[]
): FlowDepositRow[] {
  const inUnitByDeposit = new Map<number, number>();
  for (const e of carrying.unit) {
    inUnitByDeposit.set(e.deposit_movement_id, (inUnitByDeposit.get(e.deposit_movement_id) ?? 0) + e.amount);
  }
  const clpByDeposit = new Map<number, { occurred_on: string; amount: number }>();
  for (const e of carrying.clp) {
    const cur = clpByDeposit.get(e.deposit_movement_id);
    if (cur && cur.occurred_on !== e.occurred_on) {
      throw new Error(`mortgage carrying on deposit ${e.deposit_movement_id}: two days (${cur.occurred_on}, ${e.occurred_on})`);
    }
    clpByDeposit.set(e.deposit_movement_id, { occurred_on: e.occurred_on, amount: (cur?.amount ?? 0) + e.amount });
  }
  if (inUnitByDeposit.size !== clpByDeposit.size || [...inUnitByDeposit.keys()].some((id) => !clpByDeposit.has(id))) {
    throw new Error("mortgage carrying: the CLP and the unit events do not cover the same deposits");
  }
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  const accountOf = db.prepare(`SELECT COALESCE(account_id, to_account_id) AS account_id FROM movements WHERE id = ?`);
  const out: FlowDepositRow[] = [];
  for (const [depositId, { occurred_on, amount }] of clpByDeposit) {
    const accountId = (accountOf.get(depositId) as { account_id: number | null } | undefined)?.account_id;
    if (accountId == null) throw new Error(`mortgage carrying: deposit movement ${depositId} not found`);
    const acc = byId.get(accountId);
    if (!acc) throw new Error(`mortgage carrying: deposit ${depositId}'s account ${accountId} is not a deposits-page account`);
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) throw new Error(`mortgage carrying: account ${accountId} has no deposits category`);
    out.push({
      occurred_on,
      category,
      account_id: accountId,
      account_name: acc.name,
      kind_slug: acc.category_slug,
      amount_clp: -amount,
      amount: -inUnitByDeposit.get(depositId)!,
      mortgage_carrying: true,
    });
  }
  return out;
}

function aggregateDepositChartPointsBy<R extends Pick<FlowDepositRow, "occurred_on" | "category">>(
  rows: readonly R[],
  amountOf: (r: R) => number,
  grain: "month" | "day" = "month"
): FlowDepositChartPoint[] {
  const byPeriod = new Map<string, FlowDepositChartPoint>();
  for (const r of rows) {
    const pe = grain === "day" ? r.occurred_on.slice(0, 10) : monthEndFromOccurredOn(r.occurred_on);
    let pt = byPeriod.get(pe);
    if (!pt) {
      pt = {
        as_of_date: pe,
        real_estate: 0,
        cash: 0,
        brokerage: 0,
        inversiones: 0,
        total: 0,
      };
      byPeriod.set(pe, pt);
    }
    const amt = amountOf(r);
    pt[r.category] += amt;
    pt.total += amt;
  }
  const sorted = [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  if (grain === "day") return sorted;
  const emptyPoint = (as_of_date: string): FlowDepositChartPoint => ({
    as_of_date, real_estate: 0, cash: 0, brokerage: 0, inversiones: 0, total: 0,
  });
  return densifyMonthlyPoints(sorted, emptyPoint);
}

/** Retiro (the `inversiones` bucket) and brokerage net deposits per chart period, by class. */
export function inversionesBrokerageDepositsSeries(
  points: readonly FlowDepositChartPoint[]
): { as_of_date: string; retirement: number; brokerage: number }[] {
  return points.map((pt) => ({
    as_of_date: pt.as_of_date,
    retirement: pt.inversiones ?? 0,
    brokerage: pt.brokerage ?? 0,
  }));
}


// --- one display unit (`GET /api/flows/deposits?unit=`) ----------------------------------------

/** A deposit row on the wire: `amount` in the payload's unit; `amount_clp` stays inside the server. */
export type FlowDepositUnitRow = Omit<FlowDepositRow, "amount_clp">;

export type FlowDepositsUnitPayload = {
  /** The display unit every amount is in. */
  unit: string;
  rows: FlowDepositUnitRow[];
  /**
   * Monthly only: a yearly chart rolls these up client-side AFTER cutting the months at its own
   * Rango (a partial first year), so a pre-rolled yearly block would be clipped whole instead.
   */
  chart_monthly: FlowDepositChartPoint[];
  /** Diario: one point per day carrying a deposit, oldest first (the chart densifies the rest). */
  chart_daily: FlowDepositChartPoint[];
  net_total: number;
  /** AFP/AFC cotizaciones ({@link isPreTaxDepositRow}) and the rest: Σ = net total. */
  pre_tax_total: number;
  post_tax_total: number;
  fx_conversion_warnings: FxConversionWarning[];
  by_category: Record<DepositFlowCategory, { rows: FlowDepositUnitRow[]; total: number }>;
};

/**
 * The /flows/deposits page in one display unit: {@link flowDepositRowsInUnit}'s rows, their
 * charts and totals.
 */
export function buildFlowsDepositsResponse(
  unit: TsUnit,
  opts?: Parameters<typeof flowDepositRowsInUnit>[1]
): FlowDepositsUnitPayload {
  clearFxConversionWarnings();
  const rows = flowDepositRowsInUnit(unit, opts);
  const wire = (r: FlowDepositRow): FlowDepositUnitRow => {
    const { amount_clp: _clp, ...rest } = r;
    return rest;
  };
  const sum = (rs: readonly FlowDepositRow[]) => rs.reduce((s, r) => s + r.amount, 0);
  const by_category = {} as FlowDepositsUnitPayload["by_category"];
  for (const cat of DEPOSIT_FLOW_CATEGORIES) {
    const catRows = rows.filter((r) => r.category === cat);
    by_category[cat] = { rows: catRows.map(wire), total: sum(catRows) };
  }
  const preTax = rows.filter(isPreTaxDepositRow);
  const postTax = rows.filter((r) => !isPreTaxDepositRow(r));
  return {
    unit,
    rows: rows.map(wire),
    chart_monthly: aggregateDepositChartPointsBy(rows, (r) => r.amount),
    chart_daily: aggregateDepositChartPointsBy(rows, (r) => r.amount, "day"),
    by_category,
    net_total: sum(rows),
    pre_tax_total: sum(preTax),
    post_tax_total: sum(postTax),
    fx_conversion_warnings: takeFxConversionWarnings(),
  };
}
