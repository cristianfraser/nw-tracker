import { REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG } from "./ccExpenseLineBuckets";

export function chartCategorySlugsForFlowsExpenses(
  categorySlugs: readonly string[]
): string[] {
  const out = new Set(categorySlugs);
  out.add(REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG);
  return [...out];
}

/** Chart stack only: principal renders below the x-axis as a negative bar segment. */
export function expenseDepositAmortizationChartAmount(amortizationClp: number): number {
  const amt = Math.round(amortizationClp);
  if (amt <= 0) return 0;
  return -amt;
}

const CHART_TOTAL_KEY = "total";

/** Sum visible category segments; negative amortization counts as positive spend. */
export function expenseCategoryChartPointTotal(
  point: Record<string, string | number>,
  categorySlugs: readonly string[]
): number {
  let total = 0;
  for (const slug of categorySlugs) {
    const v = point[slug];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v < 0 ? -v : v;
    }
  }
  return Math.round(total);
}

export { CHART_TOTAL_KEY as EXPENSE_CHART_TOTAL_KEY };
