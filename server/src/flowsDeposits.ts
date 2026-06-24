import { accountBucketKindSlug } from "./accountBucket.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadMergedDepositInflowEvents, type DepositInflowEvent } from "./accountDeposits.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { usdCashBalanceClpAt, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import {
  clearFxConversionWarnings,
  takeFxConversionWarnings,
  type FxConversionWarning,
} from "./fxConversionWarnings.js";

/** USD for a deposit event: native USD when recorded, else CLP ÷ buy FX (sign follows CLP). */
export function depositInflowEventUsd(e: DepositInflowEvent): number | null {
  if (e.amt === 0 || !Number.isFinite(e.amt)) return 0;
  if (e.amt_usd != null && Number.isFinite(e.amt_usd)) {
    const sign = Math.sign(e.amt) || Math.sign(e.amt_usd);
    return sign * Math.abs(e.amt_usd);
  }
  return clpToUsdAtDate(e.amt, e.occurred_on);
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
  occurred_on: string;
  category: DepositFlowCategory;
  category_label: string;
  account_id: number;
  account_name: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `occurred_on` (each event converted at its own date). */
  amount_usd: number | null;
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
  chart_monthly: FlowDepositChartPoint[];
  chart_yearly: FlowDepositChartPoint[];
  chart_monthly_usd: FlowDepositChartPoint[];
  chart_yearly_usd: FlowDepositChartPoint[];
  net_total_clp: number;
  net_total_usd: number | null;
  /** True when at least one non-zero row could not be converted to USD (missing `fx_daily`). */
  fx_conversion_error: boolean;
  fx_conversion_warnings: FxConversionWarning[];
  by_category: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number | null }
  >;
};

type AccountRow = {
  account_id: number;
  name: string;
  group_slug: string;
  category_slug: string;
};

function listDepositFlowAccounts(includeExcludedFromGroupTotals = false): AccountRow[] {
  const excludedClause = includeExcludedFromGroupTotals
    ? ""
    : "AND COALESCE(a.exclude_from_group_totals, 0) = 0";
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (a.notes IS NULL OR a.notes != ?)
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
    .filter((r): r is AccountRow => r != null);
}

/** CLP → USD using `fx_daily` on or before the event date (not latest FX). */
export function depositClpToUsdAtDate(clp: number, occurredOn: string): number | null {
  return clpToUsdAtDate(clp, occurredOn);
}

function periodEndFromOccurredOn(occurredOn: string, granularity: "month" | "year"): string {
  if (granularity === "year") {
    const y = occurredOn.slice(0, 4);
    return `${y}-12-31`;
  }
  const mk = monthKeyFromYmd(occurredOn);
  return mk ? monthEndUtcYmd(mk) : occurredOn;
}

function flowsDepositsNetTotalsByAccount(opts?: {
  period?: "month" | "year";
  includeExcludedFromGroupTotals?: boolean;
}): { clp: Map<number, number>; usd: Map<number, number | null> } {
  const accounts = listDepositFlowAccounts(opts?.includeExcludedFromGroupTotals ?? false);
  const ids = accounts.map((a) => a.account_id);
  const eventsByAccount = loadMergedDepositInflowEvents(ids);
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);
  const currentY = today.slice(0, 4);
  const clp = new Map<number, number>();
  const usd = new Map<number, number | null>();
  for (const acc of accounts) {
    if (isUsdCashAccount(acc.account_id)) {
      const balanceClp = usdCashBalanceClpAt(acc.account_id, today);
      const balanceUsd = usdCashBalanceUsdAt(acc.account_id, today);
      if (opts?.period === "month") {
        const prior = priorPeriodEndYmd("mtd", today);
        clp.set(acc.account_id, balanceClp - usdCashBalanceClpAt(acc.account_id, prior));
        usd.set(acc.account_id, balanceUsd - usdCashBalanceUsdAt(acc.account_id, prior));
      } else if (opts?.period === "year") {
        const prior = priorPeriodEndYmd("ytd", today);
        clp.set(acc.account_id, balanceClp - usdCashBalanceClpAt(acc.account_id, prior));
        usd.set(acc.account_id, balanceUsd - usdCashBalanceUsdAt(acc.account_id, prior));
      } else {
        clp.set(acc.account_id, balanceClp);
        usd.set(acc.account_id, balanceUsd);
      }
      continue;
    }
    const events = eventsByAccount.get(acc.account_id) ?? [];
    let sumClp = 0;
    let sumUsd = 0;
    let fxError = false;
    for (const e of events) {
      if (e.amt === 0 || !Number.isFinite(e.amt)) continue;
      if (opts?.period === "month" && monthKeyFromYmd(e.occurred_on) !== currentMk) continue;
      if (opts?.period === "year" && e.occurred_on.slice(0, 4) !== currentY) continue;
      const amount_clp = Math.round(e.amt);
      sumClp += amount_clp;
      const amount_usd = depositInflowEventUsd(e);
      if (amount_usd == null || !Number.isFinite(amount_usd)) {
        if (amount_clp !== 0) fxError = true;
      } else {
        sumUsd += amount_usd;
      }
    }
    clp.set(acc.account_id, sumClp);
    usd.set(acc.account_id, fxError ? null : sumUsd);
  }
  return { clp, usd };
}

/** Net deposits in the current calendar month or year (flows-page accounts only). */
export function flowsDepositsNetInPeriodByAccount(period: "month" | "year"): {
  clp: Map<number, number>;
  usd: Map<number, number>;
} {
  return flowsDepositsNetTotalsByAccount({ period, includeExcludedFromGroupTotals: true });
}

/** Net capital (deposits − withdrawals) per account — same accounts as the flows deposits page. */
export function flowsDepositsNetTotalByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount({ includeExcludedFromGroupTotals: true }).clp;
}

/** Net deposits per account in USD (each event at its own FX date). Null when any event lacks FX. */
export function flowsDepositsNetTotalUsdByAccount(): Map<number, number | null> {
  return flowsDepositsNetTotalsByAccount({ includeExcludedFromGroupTotals: true }).usd;
}

/** @heavy Scans deposit-flow accounts and merges inflow events for charts + net totals. */
export function buildFlowsDepositsPayload(): FlowDepositsPayload {
  clearFxConversionWarnings();
  const accounts = listDepositFlowAccounts(false);
  const ids = accounts.map((a) => a.account_id);
  const eventsByAccount = loadMergedDepositInflowEvents(ids);

  const rows: FlowDepositRow[] = [];
  for (const acc of accounts) {
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) continue;
    const events = eventsByAccount.get(acc.account_id) ?? [];
    for (const e of events) {
      if (e.amt === 0 || !Number.isFinite(e.amt)) continue;
      const amount_clp = Math.round(e.amt);
      const amount_usd = depositInflowEventUsd(e);
      rows.push({
        occurred_on: e.occurred_on,
        category,
        category_label: CATEGORY_LABEL[category],
        account_id: acc.account_id,
        account_name: acc.name,
        amount_clp,
        amount_usd: amount_usd != null && Number.isFinite(amount_usd) ? amount_usd : null,
      });
    }
  }
  rows.sort((a, b) => {
    const d = b.occurred_on.localeCompare(a.occurred_on);
    return d !== 0 ? d : a.account_name.localeCompare(b.account_name);
  });

  const chart_monthly = aggregateDepositChartPoints(rows, "month", "clp");
  const chart_yearly = aggregateDepositChartPoints(rows, "year", "clp");
  const chart_monthly_usd = aggregateDepositChartPoints(rows, "month", "usd");
  const chart_yearly_usd = aggregateDepositChartPoints(rows, "year", "usd");

  const by_category = {} as Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number | null }
  >;
  let fx_conversion_error = false;
  for (const cat of DEPOSIT_FLOW_CATEGORIES) {
    const catRows = rows.filter((r) => r.category === cat);
    const catFxError = catRows.some((r) => r.amount_clp !== 0 && r.amount_usd == null);
    if (catFxError) fx_conversion_error = true;
    const catUsd = catFxError
      ? null
      : catRows.reduce((s, r) => s + (r.amount_usd ?? 0), 0);
    by_category[cat] = {
      label: CATEGORY_LABEL[cat],
      rows: catRows,
      total_clp: catRows.reduce((s, r) => s + r.amount_clp, 0),
      total_usd: catUsd,
    };
  }

  const net_total_clp = rows.reduce((s, r) => s + r.amount_clp, 0);
  if (rows.some((r) => r.amount_clp !== 0 && r.amount_usd == null)) fx_conversion_error = true;
  const net_total_usd = fx_conversion_error
    ? null
    : rows.reduce((s, r) => s + (r.amount_usd ?? 0), 0);

  return {
    rows,
    chart_monthly,
    chart_yearly,
    chart_monthly_usd,
    chart_yearly_usd,
    by_category,
    net_total_clp,
    net_total_usd,
    fx_conversion_error,
    fx_conversion_warnings: takeFxConversionWarnings(),
  };
}

function aggregateDepositChartPoints(
  rows: readonly FlowDepositRow[],
  granularity: "month" | "year",
  unit: "clp" | "usd"
): FlowDepositChartPoint[] {
  if (unit === "usd" && rows.some((r) => r.amount_clp !== 0 && r.amount_usd == null)) {
    return [];
  }
  const byPeriod = new Map<string, FlowDepositChartPoint>();
  for (const r of rows) {
    const pe = periodEndFromOccurredOn(r.occurred_on, granularity);
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
    const amt =
      unit === "usd"
        ? r.amount_usd != null && Number.isFinite(r.amount_usd)
          ? r.amount_usd
          : 0
        : r.amount_clp;
    pt[r.category] += amt;
    pt.total += amt;
  }
  return [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
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

