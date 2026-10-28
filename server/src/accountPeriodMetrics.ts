import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";

/**
 * One row per calendar month out of an account's monthly performance rows: the representative
 * snapshot (`pickRepresentativeMonthlyPerfRow`) carrying the month's flows summed over every
 * snapshot. The group consolidation sums these per month and the dashboard card metrics sum
 * them per period, so a card's month / year / lifetime figures equal the «Detalle por mes» /
 * «Detalle por año» rows of the same scope by construction.
 */
export function pickMonthlyPerfRowsByMonth(
  monthly: readonly AccountMonthlyPerformanceRow[]
): Map<string, AccountMonthlyPerformanceRow> {
  const byMonth = new Map<string, AccountMonthlyPerformanceRow[]>();
  for (const row of monthly) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const arr = byMonth.get(mk) ?? [];
    arr.push(row);
    byMonth.set(mk, arr);
  }
  const out = new Map<string, AccountMonthlyPerformanceRow>();
  for (const mk of [...byMonth.keys()].sort()) {
    const monthRows = byMonth.get(mk)!;
    if (monthRows.length === 1) {
      out.set(mk, monthRows[0]!);
      continue;
    }
    const picked = pickRepresentativeMonthlyPerfRow([...monthRows], mk);
    const totalFlow = monthRows.reduce((s, r) => s + r.net_capital_flow, 0);
    out.set(mk, { ...picked, net_capital_flow: totalFlow });
  }
  return out;
}

export type AccountPeriodMetrics = {
  /** Current calendar month's flows / P/L; `delta_month` null without a row for the month. */
  deposits_month: number;
  delta_month: number | null;
  /** Current calendar year, summed over its months; `delta_year` null without a row in the year. */
  deposits_year: number;
  delta_year: number | null;
  /** Every month on record; `delta_total` null without any row. */
  deposits_total: number;
  delta_total: number | null;
};

/**
 * The dashboard card's period figures, read from the same picked rows the consolidated tables
 * sum: a period's deposits are Σ `net_capital_flow` and its P/L Σ `nominal_pl` over the months
 * in it. Lifetime P/L is therefore the table's «P/L acum.», never a second formula such as
 * current − deposits — where the two would disagree the series has a hole to fix.
 */
export function accountPeriodMetricsFromMonthlyRows(
  monthly: readonly AccountMonthlyPerformanceRow[],
  today: string = chileCalendarTodayYmd()
): AccountPeriodMetrics {
  const currentMk = monthKeyFromYmd(today);
  const currentY = today.slice(0, 4);
  const out: AccountPeriodMetrics = {
    deposits_month: 0,
    delta_month: null,
    deposits_year: 0,
    delta_year: null,
    deposits_total: 0,
    delta_total: null,
  };
  for (const [mk, row] of pickMonthlyPerfRowsByMonth(monthly)) {
    const pl = row.nominal_pl != null && Number.isFinite(row.nominal_pl) ? row.nominal_pl : null;
    out.deposits_total += row.net_capital_flow;
    if (pl != null) out.delta_total = (out.delta_total ?? 0) + pl;
    if (mk.slice(0, 4) === currentY) {
      out.deposits_year += row.net_capital_flow;
      if (pl != null) out.delta_year = (out.delta_year ?? 0) + pl;
    }
    if (mk === currentMk) {
      out.deposits_month += row.net_capital_flow;
      out.delta_month = pl;
    }
  }
  return out;
}
