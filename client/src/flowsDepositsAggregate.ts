import { rollupChartPointsByYear } from "./flowsDisplay";
import type { FlowDepositChartPoint } from "./types";

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
