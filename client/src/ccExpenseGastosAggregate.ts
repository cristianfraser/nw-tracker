import { monthEndUtcYmd, ymCompare } from "./calendarMonth";
import type {
  FlowCcExpenseCategoryChartPoint,
  FlowCcExpenseChartPoint,
  FlowCcExpenseLineRow,
  FlowCcExpenseMonthRow,
} from "./types";
import {
  type CcInstallmentGastosMode,
  gastosSumMonthForLine,
  periodMonthsForGastosLine,
} from "./ccExpensePeriodMonth";
import { countsTowardGastosMes } from "./ccExpenseLineBuckets";

/** Keep in sync with server/src/flowsCreditCardExpenses.ts aggregateGastosFromLines. */
export function aggregateGastosFromLines(
  lines: readonly FlowCcExpenseLineRow[],
  chartCategorySlugs: readonly string[],
  mode: CcInstallmentGastosMode = "split"
): {
  by_month: FlowCcExpenseMonthRow[];
  chart_monthly: FlowCcExpenseChartPoint[];
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
} {
  type MonthBucket = {
    gastos: number;
    gastosReal: number;
    abonos: number;
    line_count: number;
  };

  const byMonthSum = new Map<string, MonthBucket>();
  const byMonthCategory = new Map<string, Map<string, number>>();

  const touchBucket = (month: string): MonthBucket => {
    const existing = byMonthSum.get(month);
    if (existing) return existing;
    const fresh: MonthBucket = { gastos: 0, gastosReal: 0, abonos: 0, line_count: 0 };
    byMonthSum.set(month, fresh);
    return fresh;
  };

  for (const ln of lines) {
    const sumMonth = gastosSumMonthForLine(ln, mode);
    const amount = ln.amount_clp;

    if (
      ln.nota_credito_role === "annulled_purchase" ||
      ln.nota_credito_role === "matched_nota"
    ) {
      for (const periodMonth of periodMonthsForGastosLine(ln)) {
        touchBucket(periodMonth).line_count += 1;
      }
      continue;
    }

    if (ln.nota_credito_role === "unmatched_nota") {
      if (sumMonth) {
        touchBucket(sumMonth).gastos += amount;
      }
      for (const periodMonth of periodMonthsForGastosLine(ln)) {
        touchBucket(periodMonth).line_count += 1;
      }
      continue;
    }

    if (sumMonth) {
      const sumBucket = touchBucket(sumMonth);
      if (amount > 0) {
        sumBucket.gastosReal += amount;
        // Keep in sync with server aggregateGastosFromLines (purchaseCountsAfterNotaPairing + mode).
        if (countsTowardGastosMes(ln, mode)) {
          sumBucket.gastos += amount;
          const catBucket = byMonthCategory.get(sumMonth) ?? new Map<string, number>();
          catBucket.set(ln.category_slug, (catBucket.get(ln.category_slug) ?? 0) + amount);
          byMonthCategory.set(sumMonth, catBucket);
        }
      } else {
        sumBucket.abonos += amount;
      }
    }

    for (const periodMonth of periodMonthsForGastosLine(ln)) {
      touchBucket(periodMonth).line_count += 1;
    }
  }

  const monthsAsc = [...byMonthSum.keys()].sort(ymCompare);
  let runningGastos = 0;
  let runningGastosReal = 0;
  const byMonthAsc: FlowCcExpenseMonthRow[] = [];

  for (const periodMonth of monthsAsc) {
    const bucket = byMonthSum.get(periodMonth)!;
    const gastosMes = Math.round(bucket.gastos);
    const gastosRealMes = Math.round(bucket.gastosReal);
    runningGastos += gastosMes;
    runningGastosReal += gastosRealMes;
    byMonthAsc.push({
      period_month: periodMonth,
      as_of_date: monthEndUtcYmd(periodMonth),
      gastos_mes_clp: gastosMes,
      gastos_real_mes_clp: gastosRealMes,
      abonos_mes_clp: Math.round(bucket.abonos),
      gastos_acumulado_clp: Math.round(runningGastos),
      gastos_real_acumulado_clp: Math.round(runningGastosReal),
      line_count: bucket.line_count,
    });
  }

  const by_month = [...byMonthAsc].reverse();
  const chart_monthly: FlowCcExpenseChartPoint[] = byMonthAsc.map((m) => ({
    as_of_date: m.as_of_date,
    gastos_clp: m.gastos_mes_clp,
  }));

  const chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[] = byMonthAsc.map((m) => {
    const point: FlowCcExpenseCategoryChartPoint = { as_of_date: m.as_of_date };
    const catSums = byMonthCategory.get(m.period_month) ?? new Map<string, number>();
    for (const slug of chartCategorySlugs) {
      point[slug] = Math.round(catSums.get(slug) ?? 0);
    }
    return point;
  });

  return { by_month, chart_monthly, chart_monthly_by_category };
}

export function computeExpensesTotalClp(
  lines: readonly FlowCcExpenseLineRow[],
  mode: CcInstallmentGastosMode
): { total_clp: number; total_real_clp: number } {
  let total_clp = 0;
  let total_real_clp = 0;
  for (const r of lines) {
    if (r.nota_credito_role === "annulled_purchase" || r.nota_credito_role === "matched_nota") {
      continue;
    }
    if (r.nota_credito_role === "unmatched_nota") {
      total_clp += r.amount_clp;
      if (r.amount_clp > 0) total_real_clp += r.amount_clp;
      continue;
    }
    if (r.amount_clp > 0) {
      if (countsTowardGastosMes(r, mode)) total_clp += r.amount_clp;
      if (gastosSumMonthForLine(r, mode)) total_real_clp += r.amount_clp;
    }
  }
  return { total_clp: Math.round(total_clp), total_real_clp: Math.round(total_real_clp) };
}
