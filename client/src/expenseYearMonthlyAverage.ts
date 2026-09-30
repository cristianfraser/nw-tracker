import { addCalendarMonths } from "./calendarMonth";
import { expenseCategoryChartPointTotal } from "./expenseDepositLinks";
import type { FlowCcExpenseCategoryChartPoint } from "./types";

/** One calendar year's average monthly gastos, and the months it covers (YYYY-MM, inclusive). */
export type ExpenseYearMonthlyAverage = {
  fromYm: string;
  throughYm: string;
  avg: number;
};

/**
 * Average monthly gastos per calendar year, from the chart's monthly points over FULL history
 * (the Rango only decides which part of each year's line is drawn, never the average).
 *
 * - The monthly figure is the chart's total line (`expenseCategoryChartPointTotal` over the same
 *   category slugs), so the average sits on the line it summarizes.
 * - Only complete months count: the current month and the future months Por cuota projects
 *   are left out, so the current year reads the average through last month.
 * - The first year starts at the first month with any spend; a month without points inside a
 *   covered span counts as 0.
 */
export function expenseYearMonthlyAverages(
  monthlyPoints: readonly FlowCcExpenseCategoryChartPoint[],
  categorySlugs: readonly string[],
  todayYm: string
): Map<string, ExpenseYearMonthlyAverage> {
  const lastCompleteYm = addCalendarMonths(todayYm, -1);
  const totalByYm = new Map<string, number>();
  for (const p of monthlyPoints) {
    const ym = p.as_of_date.slice(0, 7);
    totalByYm.set(ym, (totalByYm.get(ym) ?? 0) + expenseCategoryChartPointTotal(p, categorySlugs));
  }
  let firstYm: string | null = null;
  for (const [ym, total] of totalByYm) {
    if (total !== 0 && ym <= lastCompleteYm && (firstYm == null || ym < firstYm)) firstYm = ym;
  }
  const out = new Map<string, ExpenseYearMonthlyAverage>();
  if (firstYm == null) return out;

  for (let year = Number(firstYm.slice(0, 4)); year <= Number(lastCompleteYm.slice(0, 4)); year++) {
    const fromYm = `${year}-01` < firstYm ? firstYm : `${year}-01`;
    const throughYm = `${year}-12` > lastCompleteYm ? lastCompleteYm : `${year}-12`;
    let sum = 0;
    let months = 0;
    for (let ym = fromYm; ym <= throughYm; ym = addCalendarMonths(ym, 1)) {
      sum += totalByYm.get(ym) ?? 0;
      months++;
    }
    out.set(String(year), { fromYm, throughYm, avg: Math.round(sum / months) });
  }
  return out;
}
