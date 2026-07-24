import type { DisplayUnit } from "./queries/keys";
import type { FlowDepositChartPoint, FlowDepositRow } from "./types";

/**
 * Per-calendar-day deposit chart points (Diario) — mirrors the server's month/year
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
