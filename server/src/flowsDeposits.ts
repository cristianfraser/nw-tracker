import { accountBucketKindSlug } from "./accountBucket.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadMergedDisplayDepositInflowEvents, type DepositInflowEvent } from "./accountDeposits.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { densifyMonthlyPoints, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import {
  clearFxConversionWarnings,
  takeFxConversionWarnings,
  type FxConversionWarning,
} from "./fxConversionWarnings.js";
import { clpToUsdAtPayment, ufRowOnOrBefore } from "./fxRates.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * A deposit/flow event: every one carries its CLP leg (`amt`); USD-cash and equity capital
 * events also carry the dollars that actually moved (`amt_usd`).
 */
export type FlowEvent = Pick<DepositInflowEvent, "occurred_on" | "amt" | "amt_usd">;

/**
 * One deposit/flow event in `unit`, at its own date's rate — the single conversion every
 * deposit and flow reader shares (dashboard totals, window flows, aportes lines, the daily
 * grid, mortgage and property payments). A leg the event carries is used as is (CLP always;
 * USD when recorded, its sign following the CLP leg); only a missing leg converts: CLP ÷ the
 * buy rate on or before the event date, CLP ÷ that date's UF. Unrounded — callers sum first
 * and round once for display. A missing rate throws: a flow is never dropped from a total.
 */
export function flowEventInUnit(e: FlowEvent, unit: TsUnit): number {
  if (!Number.isFinite(e.amt)) {
    throw new Error(`flow event ${e.occurred_on}: non-finite CLP amount ${e.amt}`);
  }
  if (e.amt === 0) return 0;
  if (unit === "clp") return e.amt;
  if (unit === "usd") {
    if (e.amt_usd != null && Number.isFinite(e.amt_usd)) return Math.sign(e.amt) * Math.abs(e.amt_usd);
    const usd = clpToUsdAtPayment(e.amt, e.occurred_on);
    if (usd == null) {
      throw new Error(`flow event ${e.occurred_on}: no USD rate on or before the date (${e.amt} CLP)`);
    }
    return usd;
  }
  const uf = ufRowOnOrBefore(e.occurred_on);
  if (!uf || !(uf.clp_per_uf > 0)) {
    throw new Error(`flow event ${e.occurred_on}: no UF on or before the date (${e.amt} CLP)`);
  }
  return e.amt / uf.clp_per_uf;
}

/** Big-category buckets for the flows → deposits page (matches sidebar groupings). */
export const DEPOSIT_FLOW_CATEGORIES = ["real_estate", "cash", "brokerage", "inversiones"] as const;
export type DepositFlowCategory = (typeof DEPOSIT_FLOW_CATEGORIES)[number];

const CATEGORY_LABEL: Record<DepositFlowCategory, string> = {
  real_estate: "Real estate",
  cash: "Cash",
  brokerage: "Brokerage",
  inversiones: "Retirement",
};

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
  category_label: string;
  account_id: number;
  account_name: string;
  /** Account behavior kind (`afp`, `afc`, `cuenta_corriente`, …) — see accountBucketKindSlug. */
  kind_slug: string;
  /** Unrounded, like every deposit amount — the client rounds for display. */
  amount_clp: number;
  /** The event in USD at its own date's rate ({@link flowEventInUnit}). */
  amount_usd: number;
};

export type FlowDepositChartPoint = {
  as_of_date: string;
  real_estate: number;
  cash: number;
  brokerage: number;
  inversiones: number;
  total: number;
};

export type FlowDepositsPayload = {
  rows: FlowDepositRow[];
  /**
   * Monthly only: a yearly chart rolls these up client-side AFTER cutting the months at its own
   * Rango (a partial first year), so a pre-rolled yearly block would be clipped whole instead.
   */
  chart_monthly: FlowDepositChartPoint[];
  chart_monthly_usd: FlowDepositChartPoint[];
  net_total_clp: number;
  net_total_usd: number;
  fx_conversion_warnings: FxConversionWarning[];
  by_category: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number }
  >;
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

/** CLP → USD at the **buy rate** on or before the event date (deposit events = money actually moved). Balance display uses `clpToUsdForBalanceAt` instead. */
export function depositClpToUsdAtDate(clp: number, occurredOn: string): number | null {
  return clpToUsdAtDate(clp, occurredOn);
}

function monthEndFromOccurredOn(occurredOn: string): string {
  const mk = monthKeyFromYmd(occurredOn);
  return mk ? monthEndUtcYmd(mk) : occurredOn;
}

function flowsDepositsNetTotalsByAccount(
  unit: "clp" | "usd",
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
 * 2026-08-04: their events come from `loadUsdCashCapitalSortFlows` (native USD legs, per-event
 * CLP conversion), so a window with no events reads 0 in both frames instead of leaking fx
 * drift on the standing balance. Callers pass the window's prior anchor as `startYmd`
 * (exclusive) and the reference date as `endYmd` (inclusive).
 */
export function netDepositFlowBetween(
  accountId: number,
  startYmd: string,
  endYmd: string,
  unit: "clp" | "usd"
): number {
  const events = loadMergedDisplayDepositInflowEvents([accountId]).get(accountId) ?? [];
  let sum = 0;
  for (const e of events) {
    if (e.amt === 0) continue;
    if (e.occurred_on <= startYmd || e.occurred_on > endYmd) continue;
    sum += flowEventInUnit(e, unit);
  }
  return sum;
}

/**
 * Net capital flow for one account in the current calendar month through Chile today. The
 * events are display-dated, so a movement the bank posts later is already in today's
 * bucket — the same place the live balance counts it. Same event source as
 * `flowsDepositsNetInPeriodByAccount("month")`, so live current-month P/L reconciles with
 * the dashboard deposits column.
 */
export function netDepositFlowCurrentMonthThroughToday(
  accountId: number,
  unit: "clp" | "usd"
): number {
  const today = chileCalendarTodayYmd();
  return netDepositFlowBetween(accountId, priorPeriodEndYmd("mtd", today), today, unit);
}

/** Net deposits in the current calendar month or year (flows-page accounts only). */
export function flowsDepositsNetInPeriodByAccount(period: "month" | "year"): {
  clp: Map<number, number>;
  usd: Map<number, number>;
} {
  const opts = { period, includeExcludedFromGroupTotals: true };
  return {
    clp: flowsDepositsNetTotalsByAccount("clp", opts),
    usd: flowsDepositsNetTotalsByAccount("usd", opts),
  };
}

/** Net capital (deposits − withdrawals) per account — same accounts as the flows deposits page. */
export function flowsDepositsNetTotalByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount("clp", { includeExcludedFromGroupTotals: true });
}

/** Net deposits per account in USD (each event at its own date's rate — `flowEventInUnit`). */
export function flowsDepositsNetTotalUsdByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount("usd", { includeExcludedFromGroupTotals: true });
}

/** @heavy Scans deposit-flow accounts and merges inflow events for charts + net totals. */
export function buildFlowsDepositsPayload(): FlowDepositsPayload {
  clearFxConversionWarnings();
  const accounts = listDepositFlowAccounts(false);
  const ids = accounts.map((a) => a.account_id);
  const eventsByAccount = loadMergedDisplayDepositInflowEvents(ids);

  const rows: FlowDepositRow[] = [];
  for (const acc of accounts) {
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) continue;
    const events = eventsByAccount.get(acc.account_id) ?? [];
    for (const e of events) {
      if (e.amt === 0) continue;
      rows.push({
        occurred_on: e.occurred_on,
        ...(e.posted_on ? { posted_on: e.posted_on } : {}),
        category,
        category_label: CATEGORY_LABEL[category],
        account_id: acc.account_id,
        account_name: acc.name,
        kind_slug: acc.category_slug,
        amount_clp: flowEventInUnit(e, "clp"),
        amount_usd: flowEventInUnit(e, "usd"),
      });
    }
  }
  rows.sort((a, b) => {
    const d = b.occurred_on.localeCompare(a.occurred_on);
    return d !== 0 ? d : a.account_name.localeCompare(b.account_name);
  });

  const chart_monthly = aggregateDepositChartPoints(rows, "clp");
  const chart_monthly_usd = aggregateDepositChartPoints(rows, "usd");

  const by_category = {} as FlowDepositsPayload["by_category"];
  for (const cat of DEPOSIT_FLOW_CATEGORIES) {
    const catRows = rows.filter((r) => r.category === cat);
    by_category[cat] = {
      label: CATEGORY_LABEL[cat],
      rows: catRows,
      total_clp: catRows.reduce((s, r) => s + r.amount_clp, 0),
      total_usd: catRows.reduce((s, r) => s + r.amount_usd, 0),
    };
  }

  return {
    rows,
    chart_monthly,
    chart_monthly_usd,
    by_category,
    net_total_clp: rows.reduce((s, r) => s + r.amount_clp, 0),
    net_total_usd: rows.reduce((s, r) => s + r.amount_usd, 0),
    fx_conversion_warnings: takeFxConversionWarnings(),
  };
}

function aggregateDepositChartPoints(
  rows: readonly FlowDepositRow[],
  unit: "clp" | "usd"
): FlowDepositChartPoint[] {
  const byPeriod = new Map<string, FlowDepositChartPoint>();
  for (const r of rows) {
    const pe = monthEndFromOccurredOn(r.occurred_on);
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
    const amt = unit === "usd" ? r.amount_usd : r.amount_clp;
    pt[r.category] += amt;
    pt.total += amt;
  }
  const sorted = [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const emptyPoint = (as_of_date: string): FlowDepositChartPoint => ({
    as_of_date, real_estate: 0, cash: 0, brokerage: 0, inversiones: 0, total: 0,
  });
  return densifyMonthlyPoints(sorted, emptyPoint);
}

/** Retiro (inversiones) + brokerage net deposits per chart period. */
export function inversionesBrokerageDepositsSeries(
  points: readonly FlowDepositChartPoint[]
): { as_of_date: string; deposited: number }[] {
  return points.map((pt) => ({
    as_of_date: pt.as_of_date,
    deposited: (pt.brokerage ?? 0) + (pt.inversiones ?? 0),
  }));
}

