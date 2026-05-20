import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import type { TsUnit } from "./valuationTimeseries.js";

export type AccountPeriodClosePeriod = "month" | "year";

function priorCalendarMonthKeyFromToday(todayYmd: string): string {
  const y = Number(todayYmd.slice(0, 4));
  const m = Number(todayYmd.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return todayYmd.slice(0, 7);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

function bestPerformanceCloseInMonth(
  monthly: AccountMonthlyPerformanceRow[],
  monthKey: string
): number | null {
  let best: AccountMonthlyPerformanceRow | null = null;
  for (const row of monthly) {
    if (monthKeyFromYmd(row.as_of_date) !== monthKey) continue;
    if (!best || String(row.as_of_date).localeCompare(String(best.as_of_date)) > 0) {
      best = row;
    }
  }
  const v = best?.closing_value;
  return v != null && Number.isFinite(v) ? v : null;
}

/** Month-end / prior year-end close from the same performance series as Retiro P/L charts. */
export function accountPriorPeriodClose(
  accountId: number,
  period: AccountPeriodClosePeriod,
  unit: TsUnit = "clp"
): number | null {
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (!perf?.monthly.length) return null;

  const today = chileCalendarTodayYmd();

  if (period === "month") {
    const priorMk = priorCalendarMonthKeyFromToday(today);
    const exact = bestPerformanceCloseInMonth(perf.monthly, priorMk);
    if (exact != null) return exact;

    const curMk = today.slice(0, 7);
    let best: AccountMonthlyPerformanceRow | null = null;
    for (const row of perf.monthly) {
      if (monthKeyFromYmd(row.as_of_date) >= curMk) continue;
      if (!best || String(row.as_of_date).localeCompare(String(best.as_of_date)) > 0) {
        best = row;
      }
    }
    const v = best?.closing_value;
    return v != null && Number.isFinite(v) ? v : null;
  }

  const y0 = today.slice(0, 4);
  let best: AccountMonthlyPerformanceRow | null = null;
  for (const row of perf.monthly) {
    if (row.as_of_date.slice(0, 4) >= y0) continue;
    if (row.closing_value == null || !Number.isFinite(row.closing_value)) continue;
    if (!best || String(row.as_of_date).localeCompare(String(best.as_of_date)) > 0) {
      best = row;
    }
  }
  const v = best?.closing_value;
  return v != null && Number.isFinite(v) ? v : null;
}

export type AccountCardPerformanceMetrics = {
  delta_month: number | null;
  delta_year: number | null;
  delta_total: number | null;
};

/** Month / year / cumulative nominal P/L from one performance series read. */
export function accountCardPerformanceMetrics(
  accountId: number,
  unit: TsUnit = "clp"
): AccountCardPerformanceMetrics {
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (!perf?.monthly.length) {
    return { delta_month: null, delta_year: null, delta_total: null };
  }

  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);
  const currentY = today.slice(0, 4);
  const latest = perf.monthly[0];

  let delta_month: number | null = null;
  let delta_year = 0;
  let anyYear = false;

  for (const row of perf.monthly) {
    if (monthKeyFromYmd(row.as_of_date) === currentMk) {
      delta_month = row.nominal_pl;
    }
    if (row.as_of_date.slice(0, 4) === currentY && row.nominal_pl != null && Number.isFinite(row.nominal_pl)) {
      delta_year += row.nominal_pl;
      anyYear = true;
    }
  }

  if (delta_month == null) {
    const fallback = latest?.nominal_pl;
    delta_month = fallback != null && Number.isFinite(fallback) ? fallback : null;
  }

  const total = latest?.cumulative_nominal_pl;
  return {
    delta_month,
    delta_year: anyYear ? delta_year : null,
    delta_total: total != null && Number.isFinite(total) ? total : null,
  };
}
