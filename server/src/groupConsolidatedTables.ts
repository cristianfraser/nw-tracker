import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  consolidateGroupMonthlyPerf,
  getGroupConsolidationAccountMonthly,
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

type AccountMonthlyPayload = ReturnType<typeof getGroupConsolidationAccountMonthly>;

function consolidateFromAccountMonthly(
  account_monthly: AccountMonthlyPayload,
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  // Whole payloads, `import_key` included: the month-end marks are keyed by it.
  return consolidateGroupMonthlyPerf(account_monthly, unit);
}

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
  const rows = listAccountsForGroupTab(groupSlug, tabSubgroup);
  return consolidateFromAccountMonthly(
    getGroupConsolidationAccountMonthly(rows, groupSlug, unit),
    unit
  );
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
        : consolidateFromAccountMonthly(account_monthly, unit);

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

export type GroupConsolidatedMonthlyPageResponse = Paginated<ConsolidatedMonthlyPerfRow> & {
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
  tabSubgroup?: string
): GroupConsolidatedMonthlyPageResponse {
  const all = getGroupConsolidatedMonthlyRows(groupSlug, unit, tabSubgroup);
  const rows = period === "year" ? rollupMonthlyPerfYearly(all) : all;
  return { unit, group_slug: groupSlug, period, ...paginate(rows, page, pageSize) };
}
