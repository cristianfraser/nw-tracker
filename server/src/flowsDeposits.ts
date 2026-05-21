import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";

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
  net_total_usd: number;
  by_category: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number }
  >;
};

type AccountRow = {
  account_id: number;
  name: string;
  group_slug: string;
  category_slug: string;
};

function listDepositFlowAccounts(): AccountRow[] {
  return db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS group_slug, c.slug AS category_slug
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE (a.notes IS NULL OR a.notes != ?)
         AND COALESCE(a.exclude_from_group_totals, 0) = 0
         AND g.slug IN ('real_estate', 'cash_eqs', 'brokerage', 'retirement')
         AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
       ORDER BY g.sort_order, c.sort_order, a.name`
    )
    .all(NOTE_STOCKS_LEGACY) as AccountRow[];
}

/** CLP → USD using `fx_daily` on or before the event date (not latest FX). */
export function depositClpToUsdAtDate(clp: number, occurredOn: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return clp === 0 ? 0 : null;
  const fx = fxRowOnOrBefore(occurredOn);
  if (!fx || fx.clp_per_usd <= 0) return null;
  return clp / fx.clp_per_usd;
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
}): { clp: Map<number, number>; usd: Map<number, number> } {
  const accounts = listDepositFlowAccounts();
  const ids = accounts.map((a) => a.account_id);
  const eventsByAccount = loadMergedDepositInflowEvents(ids);
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);
  const currentY = today.slice(0, 4);
  const clp = new Map<number, number>();
  const usd = new Map<number, number>();
  for (const acc of accounts) {
    const events = eventsByAccount.get(acc.account_id) ?? [];
    let sumClp = 0;
    let sumUsd = 0;
    for (const e of events) {
      if (e.amt === 0 || !Number.isFinite(e.amt)) continue;
      if (opts?.period === "month" && monthKeyFromYmd(e.occurred_on) !== currentMk) continue;
      if (opts?.period === "year" && e.occurred_on.slice(0, 4) !== currentY) continue;
      const amount_clp = Math.round(e.amt);
      sumClp += amount_clp;
      const amount_usd = depositClpToUsdAtDate(amount_clp, e.occurred_on);
      if (amount_usd != null && Number.isFinite(amount_usd)) sumUsd += amount_usd;
    }
    clp.set(acc.account_id, sumClp);
    usd.set(acc.account_id, sumUsd);
  }
  return { clp, usd };
}

/** Net deposits in the current calendar month or year (flows-page accounts only). */
export function flowsDepositsNetInPeriodByAccount(period: "month" | "year"): {
  clp: Map<number, number>;
  usd: Map<number, number>;
} {
  return flowsDepositsNetTotalsByAccount({ period });
}

/** Net capital (deposits − withdrawals) per account — same accounts as the flows deposits page. */
export function flowsDepositsNetTotalByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount().clp;
}

/** Net deposits per account in USD (each event at its own FX date). */
export function flowsDepositsNetTotalUsdByAccount(): Map<number, number> {
  return flowsDepositsNetTotalsByAccount().usd;
}

export function buildFlowsDepositsPayload(): FlowDepositsPayload {
  const accounts = listDepositFlowAccounts();
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
      const amount_usd = depositClpToUsdAtDate(amount_clp, e.occurred_on);
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
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number }
  >;
  for (const cat of DEPOSIT_FLOW_CATEGORIES) {
    const catRows = rows.filter((r) => r.category === cat);
    by_category[cat] = {
      label: CATEGORY_LABEL[cat],
      rows: catRows,
      total_clp: catRows.reduce((s, r) => s + r.amount_clp, 0),
      total_usd: catRows.reduce((s, r) => s + (r.amount_usd ?? 0), 0),
    };
  }

  const net_total_clp = rows.reduce((s, r) => s + r.amount_clp, 0);
  const net_total_usd = rows.reduce((s, r) => s + (r.amount_usd ?? 0), 0);

  return {
    rows,
    chart_monthly,
    chart_yearly,
    chart_monthly_usd,
    chart_yearly_usd,
    by_category,
    net_total_clp,
    net_total_usd,
  };
}

function aggregateDepositChartPoints(
  rows: readonly FlowDepositRow[],
  granularity: "month" | "year",
  unit: "clp" | "usd"
): FlowDepositChartPoint[] {
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

