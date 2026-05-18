import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import type { TsUnit } from "./valuationTimeseries.js";

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
