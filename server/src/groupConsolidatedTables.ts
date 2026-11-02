import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  getGroupConsolidationAccountMonthly,
  groupConsolidatedMonthlyRaw,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { buildInversionesConsolidatedMonthly, buildNetWorthConsolidatedMonthly } from "./netWorthConsolidation.js";
import { paginate, type Paginated } from "./pagination.js";
import { rollupMonthlyPerfYearly } from "./monthlyPerfRollup.js";
import { computePeriodReturns, type PeriodReturnsPayload } from "./periodReturns.js";
import { withShortHorizonCells } from "./periodReturnsShortHorizon.js";
import { withDailyChainedReturns } from "./periodReturnsDaily.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";
import { groupHasPeriodReturns } from "./portfolioGroupTree.js";
import { listAccountsForGroupTab, type GroupTabAccountRow } from "./valuationTimeseries.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { buildFlowsOverviewPayload } from "./flowsOverview.js";
import type { CcInstallmentGastosMode } from "./ccExpensePeriodMonth.js";

export type { ConsolidatedMonthlyPerfRow } from "./groupMonthlyPerfConsolidation.js";

export type GroupConsolidatedTablesResponse = {
  unit: TsUnit;
  group_slug: string;
  account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
    notes: string | null;
    monthly: AccountMonthlyPerformanceRow[];
  }[];
  consolidated_monthly: ConsolidatedMonthlyPerfRow[];
  /** The «Detalle por año» rows: `consolidated_monthly` rolled up by year, newest first. */
  consolidated_yearly: ConsolidatedMonthlyPerfRow[];
  /** Chained flow-adjusted period returns; null for non-investment groups. */
  period_returns: PeriodReturnsPayload | null;
};

/** Full consolidated detalle-por-mes series for a group tab (newest first). */
export function getGroupConsolidatedMonthlyRows(
  groupSlug: string,
  unit: TsUnit = "clp",
  tabSubgroup?: string
): ConsolidatedMonthlyPerfRow[] {
  if (groupSlug === "net_worth") return buildNetWorthConsolidatedMonthly(unit);
  if (groupSlug === "inversiones" && tabSubgroup == null) {
    return buildInversionesConsolidatedMonthly(unit);
  }
  return groupConsolidatedMonthlyRaw(listAccountsForGroupTab(groupSlug, tabSubgroup), groupSlug, unit);
}

export function getGroupConsolidatedTables(
  groupSlug: string,
  unit: TsUnit = "clp",
  tabSubgroup?: string
): GroupConsolidatedTablesResponse {
  const rows = listAccountsForGroupTab(groupSlug, tabSubgroup);
  const account_monthly = getGroupConsolidationAccountMonthly(rows, groupSlug, unit);
  const consolidated_monthly =
    groupSlug === "net_worth"
      ? buildNetWorthConsolidatedMonthly(unit)
      : groupSlug === "inversiones" && tabSubgroup == null
        ? buildInversionesConsolidatedMonthly(unit)
        : groupConsolidatedMonthlyRaw(rows, groupSlug, unit);

  const period_returns = groupPeriodReturnsFromMonthly(groupSlug, unit, consolidated_monthly, rows);

  return {
    unit,
    group_slug: groupSlug,
    account_monthly,
    consolidated_monthly,
    consolidated_yearly: rollupMonthlyPerfYearly(consolidated_monthly),
    period_returns,
  };
}

/**
 * Chained period returns (month windows chained from the group's daily series, 1D/1W from the
 * marks); null for a group with no Rentabilidad table (`groupHasPeriodReturns`).
 */
function groupPeriodReturnsFromMonthly(
  groupSlug: string,
  unit: TsUnit,
  consolidated_monthly: ConsolidatedMonthlyPerfRow[],
  rows: readonly GroupTabAccountRow[]
): PeriodReturnsPayload | null {
  if (!groupHasPeriodReturns(groupSlug)) return null;
  return withShortHorizonCells(
    withDailyChainedReturns(
      computePeriodReturns(consolidated_monthly, unit),
      resolveGroupDailySeries(groupSlug, unit, 0)?.points ?? []
    ),
    rows,
    unit
  );
}

export type GroupPeriodReturnsResponse = {
  unit: TsUnit;
  group_slug: string;
  period_returns: PeriodReturnsPayload | null;
};

/**
 * The Rentabilidad table alone, with the consolidated monthly rows it is built from — for pages
 * that do not load the whole consolidated-tables payload (the home dashboard, whose detalle table
 * is server-paginated) and for the benchmark row.
 */
export function getGroupPeriodReturns(
  groupSlug: string,
  unit: TsUnit = "clp"
): GroupPeriodReturnsResponse & { consolidated_monthly: ConsolidatedMonthlyPerfRow[] } {
  const consolidated_monthly = getGroupConsolidatedMonthlyRows(groupSlug, unit);
  const period_returns = groupPeriodReturnsFromMonthly(
    groupSlug,
    unit,
    consolidated_monthly,
    listAccountsForGroupTab(groupSlug, undefined)
  );
  return { unit, group_slug: groupSlug, consolidated_monthly, period_returns };
}

export type ConsolidatedMonthlyPeriod = "month" | "year";

/**
 * A detalle row of the net-worth page: what came in and what was spent that month (or year), from
 * the flows overview — the money its «net contributions» is the difference of.
 */
export type ConsolidatedMonthlyPageRow = ConsolidatedMonthlyPerfRow & {
  income?: number;
  expenses?: number;
};

export type GroupConsolidatedMonthlyPageResponse = Paginated<ConsolidatedMonthlyPageRow> & {
  unit: TsUnit;
  group_slug: string;
  period: ConsolidatedMonthlyPeriod;
};

/** One server page of the consolidated detalle table (`period=year` rolls up before slicing). */
export function getGroupConsolidatedMonthlyPage(
  groupSlug: string,
  unit: TsUnit,
  period: ConsolidatedMonthlyPeriod,
  page: number,
  pageSize: number,
  tabSubgroup?: string,
  /** Net worth: the expense mode its income and expenses are counted in (the dashboard's). */
  installmentMode?: CcInstallmentGastosMode
): GroupConsolidatedMonthlyPageResponse {
  const all = getGroupConsolidatedMonthlyRows(groupSlug, unit, tabSubgroup);
  const rows = period === "year" ? rollupMonthlyPerfYearly(all) : all;
  const shown =
    groupSlug === "net_worth" && installmentMode != null && unit !== "uf"
      ? withIncomeAndExpenses(rows, unit, installmentMode, period)
      : rows;
  return { unit, group_slug: groupSlug, period, ...paginate(shown, page, pageSize) };
}

/** Each row's income and expenses: the flows overview's months, summed by year on a yearly row. */
function withIncomeAndExpenses(
  rows: readonly ConsolidatedMonthlyPerfRow[],
  unit: "clp" | "usd",
  installmentMode: CcInstallmentGastosMode,
  period: ConsolidatedMonthlyPeriod
): ConsolidatedMonthlyPageRow[] {
  const keyLength = period === "year" ? 4 : 7;
  const byPeriod = new Map<string, { income: number; expenses: number }>();
  for (const m of buildFlowsOverviewPayload(unit, installmentMode, null).months) {
    const key = m.period_month.slice(0, keyLength);
    const acc = byPeriod.get(key) ?? { income: 0, expenses: 0 };
    acc.income += m.income;
    acc.expenses += m.expenses;
    byPeriod.set(key, acc);
  }
  return rows.map((row) => {
    const flows = byPeriod.get(row.as_of_date.slice(0, keyLength));
    return flows ? { ...row, income: flows.income, expenses: flows.expenses } : row;
  });
}
