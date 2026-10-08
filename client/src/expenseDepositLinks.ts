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
