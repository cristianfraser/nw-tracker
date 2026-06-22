import type { CardGroupMetricsPeriod } from "./dashboardCardBreakdown";
import { formatClp, formatUsd } from "./format";
import type { DisplayUnit } from "./queries/keys";

export type FlowChartGranularity = "month" | "year";

export function flowChartGranularityFromMetricsPeriod(
  period: CardGroupMetricsPeriod
): FlowChartGranularity {
  return period === "year" ? "year" : "month";
}

export function formatFlowMoney(amount: number, unit: DisplayUnit): string {
  return unit === "usd" ? formatUsd(amount) : formatClp(amount);
}

type NumericChartPoint = {
  as_of_date: string;
  [key: string]: string | number;
};

/** Sum monthly chart points into calendar-year buckets (Dec 31 labels). */
export function rollupChartPointsByYear<T extends NumericChartPoint>(
  points: readonly T[],
  valueKeys: readonly string[]
): T[] {
  const byYear = new Map<string, Record<string, number>>();
  for (const point of points) {
    const year = String(point.as_of_date).slice(0, 4);
    const bucket = byYear.get(year) ?? {};
    for (const key of valueKeys) {
      const v = point[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        bucket[key] = (bucket[key] ?? 0) + v;
      }
    }
    byYear.set(year, bucket);
  }
  return [...byYear.keys()].sort().map((year) => {
    const sums = byYear.get(year)!;
    const row = { as_of_date: `${year}-12-31`, ...sums } as T;
    return row;
  });
}

export function flowPeriodLabel(periodMonth: string, granularity: FlowChartGranularity): string {
  if (granularity === "year") return periodMonth.slice(0, 4);
  const [ys, ms] = periodMonth.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1]! : periodMonth;
  return `${label} ${ys}`;
}
