import type { CardGroupMetricsPeriod } from "./dashboardCardBreakdown";
import { formatClp, formatUsd } from "./format";
import type { DisplayUnit } from "./queries/keys";

export type FlowChartGranularity = "day" | "month" | "year";

export function flowChartGranularityFromMetricsPeriod(
  period: CardGroupMetricsPeriod
): FlowChartGranularity {
  return period;
}

/**
 * Period-detail tables stay at month/year grain even in Diario (a per-day flows table over
 * years is unwieldy — the daily surface is the chart). Charts get the full granularity; tables
 * get this clamp.
 */
export function flowTableGranularity(g: FlowChartGranularity): "month" | "year" {
  return g === "year" ? "year" : "month";
}

export function formatFlowMoney(amount: number, unit: DisplayUnit): string {
  return unit === "usd" ? formatUsd(amount) : formatClp(amount);
}

/**
 * Sum a numeric field across chart points — used for the Rango "en el rango" companion
 * total, computed over the already-clipped points so the number always matches the bars.
 */
export function sumChartPointsField<T>(points: readonly T[], field: keyof T & string): number {
  let sum = 0;
  for (const p of points) {
    const v = (p as Record<string, unknown>)[field];
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum;
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
  // Day grain keeps the ISO date (tables clamp to month/year, so this is a defensive branch).
  if (granularity === "day") return periodMonth.slice(0, 10);
  const [ys, ms] = periodMonth.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1]! : periodMonth;
  return `${label} ${ys}`;
}
