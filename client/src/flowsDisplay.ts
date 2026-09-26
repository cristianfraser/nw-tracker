import type { CardGroupMetricsPeriod } from "./dashboardCardBreakdown";
import { formatClp, formatUsd } from "./format";
import { formatYearMonthLabel } from "./formatDateLabel";
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

/**
 * Roll monthly chart points up into calendar-year buckets (Dec 31 labels). `valueKeys` are flows
 * and sum over the year's months. `levelKeys` are running levels (a cumulative total) and take the
 * year's LAST month instead: summing a level double counts, and a level keeps its full-history
 * frame even when the months were cut at a Rango start first (see `clipMonthsThenRollup`).
 */
export function rollupChartPointsByYear<T extends { as_of_date: string }>(
  points: readonly T[],
  valueKeys: readonly (keyof T & string)[],
  opts?: { levelKeys?: readonly (keyof T & string)[] }
): T[] {
  const byYear = new Map<string, { sums: Record<string, number>; last: T }>();
  for (const point of points) {
    const year = String(point.as_of_date).slice(0, 4);
    let bucket = byYear.get(year);
    if (!bucket) {
      bucket = { sums: {}, last: point };
      byYear.set(year, bucket);
    } else if (point.as_of_date >= bucket.last.as_of_date) {
      bucket.last = point;
    }
    for (const key of valueKeys) {
      const v = point[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        bucket.sums[key] = (bucket.sums[key] ?? 0) + v;
      }
    }
  }
  return [...byYear.keys()].sort().map((year) => {
    const { sums, last } = byYear.get(year)!;
    const levels: Record<string, unknown> = {};
    for (const key of opts?.levelKeys ?? []) levels[key] = last[key];
    return { as_of_date: `${year}-12-31`, ...sums, ...levels } as unknown as T;
  });
}

/**
 * Period cell label for a flows table: `YYYY` at year grain, else the month name in the UI
 * language (`dic 2026` / `Dec 2026`). Accepts `YYYY-MM` or a full `YYYY-MM-DD`. Reads the
 * language at call time — render-time only, never cached.
 */
export function flowPeriodLabel(periodMonth: string, granularity: FlowChartGranularity): string {
  if (granularity === "year") return periodMonth.slice(0, 4);
  // Day grain keeps the ISO date (tables clamp to month/year, so this is a defensive branch).
  if (granularity === "day") return periodMonth.slice(0, 10);
  return formatYearMonthLabel(periodMonth);
}
