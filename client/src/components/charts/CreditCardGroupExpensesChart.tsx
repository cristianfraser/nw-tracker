import type { ReactNode } from "react";
import { useMemo } from "react";
import { chileTodayYmd } from "../../calendarMonth";
import type { DisplayUnit } from "../../queries/keys";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import type {
  CcExpenseCategoryDto,
  ExpenseYearMonthlyAverage,
  FlowCcExpenseCategoryChartPoint,
} from "../../types";
import { chartCcExpenseCategories } from "../../ccExpenseCategories";
import { StackedExpensesChart } from "./StackedExpensesChart";

/** The Expenses page chart: gastos stacked by category, one legend entry per category. */
export function CreditCardGroupExpensesChart({
  title,
  controls,
  points,
  categorySortPoints,
  categories,
  displayUnit = "clp",
  xAxisGranularity = "month",
  yearAverages,
  loading,
}: {
  title: string;
  /** Per-surface Período/Rango controls, rendered next to the title. */
  controls?: ReactNode;
  points: readonly FlowCcExpenseCategoryChartPoint[];
  /** When set, category stack order is derived from these (unfiltered) points. */
  categorySortPoints?: readonly FlowCcExpenseCategoryChartPoint[];
  categories: readonly CcExpenseCategoryDto[];
  displayUnit?: DisplayUnit;
  xAxisGranularity?: "month" | "year";
  /**
   * Per-year average monthly gastos, drawn as one flat segment per year over its months on the
   * axis (with a toggle). Null/absent = not offered (yearly chart, short Rango).
   */
  yearAverages?: Readonly<Record<string, ExpenseYearMonthlyAverage>> | null;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const bars = useMemo(
    () => chartCcExpenseCategories(categories, categorySortPoints ?? points),
    [categories, categorySortPoints, points]
  );
  // Labels translated at render (a language change re-renders the tree).
  const series = bars.map((b) => ({
    dataKey: b.slug,
    label: ccExpenseCategoryLabel(b.slug),
    color: b.chart_color,
    legendKey: b.slug,
  }));
  return (
    <StackedExpensesChart
      title={title}
      controls={controls}
      points={points}
      series={series}
      legend={series.map((s) => ({ key: s.legendKey, label: s.label, color: s.color }))}
      emptyMessage={t("expenses.creditCard.chartEmpty")}
      displayUnit={displayUnit}
      xAxisGranularity={xAxisGranularity}
      extendThroughYmd={chileTodayYmd()}
      yearAverages={yearAverages}
      loading={loading}
    />
  );
}
