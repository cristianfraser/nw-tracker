import { rollupChartPointsByYear } from "./flowsDisplay";
import type { FlowsPlChartPoint } from "./types";

/**
 * Yearly flows-P/L rows from the server's monthly block — for the chart (fed through
 * `clipMonthsThenRollup`, so a Rango that starts mid-year gives a partial first year) and for the
 * year table (full history), so the two can't disagree. The bucket P/L and `total` sum;
 * `ytd_total` is the year's own total (one row per year, the YTD resets each January);
 * `cumulative_total` is a running level and takes the year's last month — the full-history
 * figure, whatever window the months were cut to.
 */
export function rollupFlowsPlChartPointsByYear(
  points: readonly FlowsPlChartPoint[]
): FlowsPlChartPoint[] {
  return rollupChartPointsByYear(points, ["brokerage", "retirement", "cash", "total"], {
    levelKeys: ["cumulative_total"],
  }).map((pt) => ({ ...pt, ytd_total: pt.total }));
}
