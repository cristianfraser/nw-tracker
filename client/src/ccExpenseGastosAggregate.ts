import { monthEndUtcYmd, ymCompare } from "./calendarMonth";
import type { DisplayUnit } from "./queries/keys";
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
import {
  BILLS_CC_EXPENSE_SLUG,
  countsTowardGastosMes,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./ccExpenseLineBuckets";
import { expenseDepositAmortizationChartAmount } from "./expenseDepositLinks";

export function hasSplittableMortgageExpenseDepositLink(
  link:
    | {
        payment_clp: number;
        amortization_clp: number;
        carrying_clp: number;
      }
    | undefined
): link is { payment_clp: number; amortization_clp: number; carrying_clp: number } {
  return (
    link != null &&
    link.amortization_clp > 0 &&
    link.carrying_clp > 0 &&
    link.carrying_clp < link.payment_clp
  );
}

export function expenseLineGastosAmount(line: FlowCcExpenseLineRow, unit: DisplayUnit): number {
  if (unit === "usd") {
    if (line.amount_usd_at_expense == null) {
      throw new Error(
        `missing amount_usd_at_expense for expense line ${line.source}:${line.statement_line_id}`
      );
    }
    return line.amount_usd_at_expense;
  }
  return line.amount_clp;
}

export function rollupExpenseMonthRowsByYear(
  rows: readonly FlowCcExpenseMonthRow[]
): FlowCcExpenseMonthRow[] {
  const byYear = new Map<string, Omit<FlowCcExpenseMonthRow, "gastos_acumulado_clp" | "gastos_real_acumulado_clp">>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
        gastos_mes_clp: row.gastos_mes_clp,
        gastos_real_mes_clp: row.gastos_real_mes_clp,
        abonos_mes_clp: row.abonos_mes_clp,
        line_count: row.line_count,
      });
      continue;
    }
    cur.gastos_mes_clp += row.gastos_mes_clp;
    cur.gastos_real_mes_clp += row.gastos_real_mes_clp;
    cur.abonos_mes_clp += row.abonos_mes_clp;
    cur.line_count += row.line_count;
  }
  let runningGastos = 0;
  let runningGastosReal = 0;
  return [...byYear.keys()].sort().map((year) => {
    const row = byYear.get(year)!;
    runningGastos += row.gastos_mes_clp;
    runningGastosReal += row.gastos_real_mes_clp;
    return {
      ...row,
      gastos_acumulado_clp: Math.round(runningGastos),
      gastos_real_acumulado_clp: Math.round(runningGastosReal),
    };
  });
}

/** Keep in sync with server/src/flowsCreditCardExpenses.ts aggregateGastosFromLines. */
export function aggregateGastosFromLines(
  lines: readonly FlowCcExpenseLineRow[],
  chartCategorySlugs: readonly string[],
  mode: CcInstallmentGastosMode = "split",
  excludedBigGroupSlugs?: ReadonlySet<string>,
  unit: DisplayUnit = "clp"
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
    const amount = expenseLineGastosAmount(ln, unit);

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
        const link = ln.expense_deposit_link;
        const linkedMortgagePayment = hasSplittableMortgageExpenseDepositLink(link);
        if (linkedMortgagePayment) {
          if (
            ln.nota_credito_role !== "annulled_purchase" &&
            ln.nota_credito_role !== "matched_nota" &&
            (ln.line_role !== "installment_purchase_total" || mode === "total") &&
            (ln.line_role !== "installment_cuota" || mode === "split")
          ) {
            sumBucket.gastos += link.carrying_clp;
            const skipChartCategory =
              ln.big_group_slug != null &&
              excludedBigGroupSlugs?.has(ln.big_group_slug) === true;
            if (!skipChartCategory) {
              const catBucket = byMonthCategory.get(sumMonth) ?? new Map<string, number>();
              if (link.carrying_clp > 0) {
                catBucket.set(
                  BILLS_CC_EXPENSE_SLUG,
                  (catBucket.get(BILLS_CC_EXPENSE_SLUG) ?? 0) + link.carrying_clp
                );
              }
              catBucket.set(
                REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
                (catBucket.get(REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG) ?? 0) +
                  expenseDepositAmortizationChartAmount(link.amortization_clp)
              );
              byMonthCategory.set(sumMonth, catBucket);
            }
          }
        } else if (countsTowardGastosMes(ln, mode)) {
          sumBucket.gastos += amount;
          const skipChartCategory =
            ln.big_group_slug != null &&
            excludedBigGroupSlugs?.has(ln.big_group_slug) === true;
          if (!skipChartCategory) {
            const catBucket = byMonthCategory.get(sumMonth) ?? new Map<string, number>();
            catBucket.set(ln.category_slug, (catBucket.get(ln.category_slug) ?? 0) + amount);
            byMonthCategory.set(sumMonth, catBucket);
          }
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

export function computeExpensesTotal(
  lines: readonly FlowCcExpenseLineRow[],
  mode: CcInstallmentGastosMode,
  unit: DisplayUnit = "clp"
): { total: number; total_real: number } {
  let total = 0;
  let total_real = 0;
  for (const r of lines) {
    const amount = expenseLineGastosAmount(r, unit);
    if (r.nota_credito_role === "annulled_purchase" || r.nota_credito_role === "matched_nota") {
      continue;
    }
    if (r.nota_credito_role === "unmatched_nota") {
      total += amount;
      if (amount > 0) total_real += amount;
      continue;
    }
    if (amount > 0) {
      const link = r.expense_deposit_link;
      const linkedMortgagePayment = hasSplittableMortgageExpenseDepositLink(link);
      if (linkedMortgagePayment) {
        if (
          r.nota_credito_role !== "annulled_purchase" &&
          r.nota_credito_role !== "matched_nota" &&
          (r.line_role !== "installment_purchase_total" || mode === "total") &&
          (r.line_role !== "installment_cuota" || mode === "split")
        ) {
          total += link.carrying_clp;
        }
      } else if (countsTowardGastosMes(r, mode)) {
        total += amount;
      }
      if (gastosSumMonthForLine(r, mode)) total_real += amount;
    }
  }
  return {
    total: unit === "clp" ? Math.round(total) : total,
    total_real: unit === "clp" ? Math.round(total_real) : total_real,
  };
}

/** @deprecated Use computeExpensesTotal */
export function computeExpensesTotalClp(
  lines: readonly FlowCcExpenseLineRow[],
  mode: CcInstallmentGastosMode
): { total_clp: number; total_real_clp: number } {
  const { total, total_real } = computeExpensesTotal(lines, mode, "clp");
  return { total_clp: total, total_real_clp: total_real };
}
