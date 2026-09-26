import { rollupChartPointsByYear } from "./flowsDisplay";
import type { DisplayUnit } from "./queries/keys";
import type { FlowDepositChartPoint, FlowDepositRow } from "./types";

const DEPOSIT_CHART_KEYS = ["real_estate", "cash", "brokerage", "inversiones", "total"] as const;

/**
 * Yearly deposit chart rows from the server's monthly block (every category is a flow: it sums).
 * The chart feeds it through `clipMonthsThenRollup`, so a Rango that starts mid-year gives a
 * partial first year.
 */
export function rollupDepositChartPointsByYear(
  points: readonly FlowDepositChartPoint[]
): FlowDepositChartPoint[] {
  return rollupChartPointsByYear(points, DEPOSIT_CHART_KEYS);
}

/**
 * Per-calendar-day deposit chart points (Diario) — mirrors the server's monthly
 * `aggregateDepositChartPoints` at day grain over the shipped event rows. One point per day
 * with events; the chart's calendar-day densify fills the empty days. Σ(day points in a
 * month) reconciles to the server monthly chart point by construction (same rows, same amounts).
 */
export function aggregateDepositChartPointsByDay(
  rows: readonly FlowDepositRow[],
  unit: DisplayUnit
): FlowDepositChartPoint[] {
  // Mirror the server: an unconvertible USD row voids the whole USD series (fail loud, not silent 0s).
  if (unit === "usd" && rows.some((r) => r.amount_clp !== 0 && r.amount_usd == null)) {
    return [];
  }
  const byDay = new Map<string, FlowDepositChartPoint>();
  for (const r of rows) {
    const day = r.occurred_on.slice(0, 10);
    let pt = byDay.get(day);
    if (!pt) {
      pt = { as_of_date: day, real_estate: 0, cash: 0, brokerage: 0, inversiones: 0, total: 0 };
      byDay.set(day, pt);
    }
    const amt =
      unit === "usd"
        ? r.amount_usd != null && Number.isFinite(r.amount_usd)
          ? r.amount_usd
          : 0
        : r.amount_clp;
    pt[r.category] += amt;
    pt.total += amt;
  }
  return [...byDay.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
}
