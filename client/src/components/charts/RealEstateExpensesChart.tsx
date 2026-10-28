import type { ReactNode } from "react";
import { desaturateStroke } from "../../chartColors";
import { expenseKindLabel, useTranslation } from "../../i18n";
import type { FlowExpenseChartPoint, RealEstateChartSeriesDto } from "../../types";
import { StackedExpensesChart } from "./StackedExpensesChart";

/**
 * One hue per bill kind, in the server's stacking order (the legend follows it); the alternate
 * scheme is the same hue, slightly desaturated.
 */
const KIND_COLORS: Record<RealEstateChartSeriesDto["kind"], string> = {
  mortgage_amortization: "#3730a3",
  mortgage_extra_amortization: "#6366f1",
  mortgage_carrying: "#a5b4fc",
  rent: "#8b5cf6",
  gastos_comunes: "#ec4899",
  electricidad: "#eab308",
  water: "#06b6d4",
  internet: "#22c55e",
  gas: "#ef4444",
  contribuciones: "#f97316",
};

const ALTERNATE_SATURATION = 0.7;

function seriesColor(s: RealEstateChartSeriesDto): string {
  const base = KIND_COLORS[s.kind];
  return s.scheme === "base" ? base : desaturateStroke(base, ALTERNATE_SATURATION);
}

/**
 * Gastos › Inmuebles: bills stacked by kind, places alternating between two schemes. One legend
 * entry per kind hides that kind for every place.
 */
export function RealEstateExpensesChart({
  title,
  controls,
  points,
  series,
  placeLabels,
  xAxisGranularity = "month",
  loading,
}: {
  title: string;
  /** Per-surface Período/Rango controls, rendered next to the title. */
  controls?: ReactNode;
  points: FlowExpenseChartPoint[];
  /** The scope's series in stacking order (from the payload). */
  series: readonly RealEstateChartSeriesDto[];
  placeLabels: ReadonlyMap<string, string>;
  xAxisGranularity?: "month" | "year";
  loading?: boolean;
}) {
  const { t } = useTranslation();
  // Labels translated at render (a language change re-renders the tree).
  const stacked = series.map((s) => ({
    dataKey: s.data_key,
    label: `${placeLabels.get(s.place_slug) ?? s.place_slug} · ${expenseKindLabel(s.kind)}`,
    color: seriesColor(s),
    legendKey: s.kind,
  }));
  const present = new Set(series.map((s) => s.kind));
  const legend = (Object.keys(KIND_COLORS) as RealEstateChartSeriesDto["kind"][])
    .filter((k) => present.has(k))
    .map((k) => ({ key: k, label: expenseKindLabel(k), color: KIND_COLORS[k] }));
  return (
    <StackedExpensesChart
      title={title}
      titleAs="h2"
      controls={controls}
      points={points}
      series={stacked}
      legend={legend}
      emptyMessage={t("charts.noExpensesInPeriod")}
      xAxisGranularity={xAxisGranularity}
      showTotalLine={false}
      loading={loading}
    />
  );
}
