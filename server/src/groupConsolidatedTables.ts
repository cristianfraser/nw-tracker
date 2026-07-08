import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import {
  consolidateGroupMonthlyPerf,
  getGroupConsolidationAccountMonthly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { buildInversionesConsolidatedMonthly, buildNetWorthConsolidatedMonthly } from "./netWorthConsolidation.js";
import { paginate, type Paginated } from "./pagination.js";
import { computePeriodReturns, type PeriodReturnsPayload } from "./periodReturns.js";
import { withShortHorizonCells } from "./periodReturnsShortHorizon.js";
import { isInvestmentPerformanceGroupSlug } from "./portfolioGroupTree.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
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
  /** Chained flow-adjusted period returns; null for non-investment groups. */
  period_returns: PeriodReturnsPayload | null;
};

type AccountMonthlyPayload = ReturnType<typeof getGroupConsolidationAccountMonthly>;

function consolidateFromAccountMonthly(
  account_monthly: AccountMonthlyPayload,
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  return consolidateGroupMonthlyPerf(
    account_monthly.map((p) => ({
      account_id: p.account_id,
      bucket_slug: p.bucket_slug,
      monthly: p.monthly,
      notes: p.notes,
      name: p.name,
    })),
    unit
  );
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

  const period_returns = isInvestmentPerformanceGroupSlug(groupSlug)
    ? withShortHorizonCells(computePeriodReturns(consolidated_monthly, unit), rows, unit)
    : null;

  return { unit, group_slug: groupSlug, account_monthly, consolidated_monthly, period_returns };
}

export type ConsolidatedMonthlyPeriod = "month" | "year";

/**
 * Yearly rollup of consolidated monthly rows (mirrors the client-side rollup used by
 * client-paginated detalle tables): flows/P-L sum per year, % compounds the months,
 * closing/cumulative take the year's latest month, and the YTD column becomes a
 * decade-to-date running P/L (resets on years ending in 0). Returns newest-first.
 */
export function rollupConsolidatedMonthlyYearly(
  rows: readonly ConsolidatedMonthlyPerfRow[]
): ConsolidatedMonthlyPerfRow[] {
  if (!rows.length) return [];

  const byYear = new Map<string, ConsolidatedMonthlyPerfRow[]>();
  for (const row of rows) {
    const year = row.as_of_date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(row);
  }

  const yearsAsc = [...byYear.keys()].sort((a, b) => a.localeCompare(b));

  let dtdSum = 0;
  let currentDecadeStart = -1;

  const ascRows = yearsAsc.map((year) => {
    const monthsAsc = [...byYear.get(year)!].sort((a, b) =>
      a.as_of_date.localeCompare(b.as_of_date)
    );
    const latest = monthsAsc[monthsAsc.length - 1]!;

    const netCapitalFlow = monthsAsc.reduce((s, r) => s + (r.net_capital_flow ?? 0), 0);
    const stockUnitsInflow = monthsAsc.reduce((s, r) => s + (r.stock_units_inflow ?? 0), 0);
    const nominalPl = monthsAsc.reduce((s, r) => s + (r.nominal_pl ?? 0), 0);

    const pctYear =
      monthsAsc.reduce((prod, r) => {
        const p = r.pct_month;
        return prod * (1 + (p != null && Number.isFinite(p) ? p : 0));
      }, 1) - 1;

    const y = Number(year);
    const decadeStart = y - (y % 10);
    if (decadeStart !== currentDecadeStart) {
      dtdSum = 0;
      currentDecadeStart = decadeStart;
    }
    dtdSum += nominalPl;

    return {
      ...latest,
      as_of_date: `${year}-12-31`,
      net_capital_flow: netCapitalFlow,
      stock_units_inflow: stockUnitsInflow,
      nominal_pl: nominalPl,
      pct_month: pctYear,
      ytd_nominal_pl: dtdSum,
      cumulative_nominal_pl: latest.cumulative_nominal_pl,
    } satisfies ConsolidatedMonthlyPerfRow;
  });

  return ascRows.reverse();
}

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
  const rows = period === "year" ? rollupConsolidatedMonthlyYearly(all) : all;
  return { unit, group_slug: groupSlug, period, ...paginate(rows, page, pageSize) };
}
