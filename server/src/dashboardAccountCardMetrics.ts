import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import { priorCloseFromPerfRows } from "./accountPeriodMarks.js";
import type { TsUnit } from "./valuationTimeseries.js";

export type AccountPeriodClosePeriod = "month" | "year";

/** Month-end / prior year-end close from an already-loaded performance series. */
export function accountPriorPeriodCloseFromPerf(
  perf: { monthly: AccountMonthlyPerformanceRow[] },
  period: AccountPeriodClosePeriod,
  todayYmd: string = chileCalendarTodayYmd()
): number | null {
  if (!perf.monthly.length) return null;
  const anchor = period === "month" ? "mtd" : "ytd";
  return priorCloseFromPerfRows(perf.monthly, anchor, todayYmd);
}

/** Month-end / prior year-end close from the same performance series as Retiro P/L charts. */
export function accountPriorPeriodClose(
  accountId: number,
  period: AccountPeriodClosePeriod,
  unit: TsUnit = "clp"
): number | null {
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (!perf) return null;
  return accountPriorPeriodCloseFromPerf(perf, period);
}

export type AccountCardPerformanceMetrics = {
  delta_month: number | null;
  delta_year: number | null;
  delta_total: number | null;
};

/** Month / year / cumulative nominal P/L from an already-loaded performance series. */
export function accountCardPerformanceMetricsFromPerf(
  perf: { monthly: AccountMonthlyPerformanceRow[] },
  todayYmd: string = chileCalendarTodayYmd()
): AccountCardPerformanceMetrics {
  if (!perf.monthly.length) {
    return { delta_month: null, delta_year: null, delta_total: null };
  }

  const currentMk = monthKeyFromYmd(todayYmd);
  const currentY = todayYmd.slice(0, 4);
  const latest = perf.monthly[0];

  let delta_month: number | null = null;
  let delta_year = 0;
  let anyYear = false;

  const byMonth = new Map<string, AccountMonthlyPerformanceRow[]>();
  for (const row of perf.monthly) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const arr = byMonth.get(mk) ?? [];
    arr.push(row);
    byMonth.set(mk, arr);
  }

  const currentMonthRows = byMonth.get(currentMk);
  if (currentMonthRows?.length) {
    delta_month = pickRepresentativeMonthlyPerfRow(currentMonthRows, currentMk).nominal_pl;
  }

  for (const [mk, monthRows] of byMonth) {
    if (mk.slice(0, 4) !== currentY) continue;
    const row =
      mk === currentMk
        ? pickRepresentativeMonthlyPerfRow(monthRows, mk)
        : monthRows.reduce((best, r) =>
            !best || String(r.as_of_date).localeCompare(String(best.as_of_date)) > 0 ? r : best
          )!;
    if (row.nominal_pl != null && Number.isFinite(row.nominal_pl)) {
      delta_year += row.nominal_pl;
      anyYear = true;
    }
  }

  const total = latest?.cumulative_nominal_pl;
  return {
    delta_month,
    delta_year: anyYear ? delta_year : null,
    delta_total: total != null && Number.isFinite(total) ? total : null,
  };
}

/** Month / year / cumulative nominal P/L from one performance series read. */
export function accountCardPerformanceMetrics(
  accountId: number,
  unit: TsUnit = "clp"
): AccountCardPerformanceMetrics {
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (!perf) {
    return { delta_month: null, delta_year: null, delta_total: null };
  }
  return accountCardPerformanceMetricsFromPerf(perf);
}

/** Card metrics + prior closes from one performance fetch per unit. */
export function dashboardAccountPerfDerived(
  accountId: number,
  unit: TsUnit,
  trackAssetMetrics: boolean
): {
  metrics: AccountCardPerformanceMetrics | null;
  prior_month_close: number | undefined;
  prior_year_close: number | undefined;
} {
  if (!trackAssetMetrics) {
    return { metrics: null, prior_month_close: undefined, prior_year_close: undefined };
  }
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (!perf) {
    return { metrics: null, prior_month_close: undefined, prior_year_close: undefined };
  }
  return {
    metrics: accountCardPerformanceMetricsFromPerf(perf),
    prior_month_close: accountPriorPeriodCloseFromPerf(perf, "month") ?? undefined,
    prior_year_close: accountPriorPeriodCloseFromPerf(perf, "year") ?? undefined,
  };
}
