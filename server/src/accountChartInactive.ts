import { getAccountMonthlyPerformance } from "./accountPerformance.js";

/**
 * Matches client {@link DEFAULT_TRAILING_ZERO_MONTHS_KEPT}: months of trailing **zero** balance
 * kept at the end of the monthly closing series before the rest is treated as inactive tail.
 */
export const CHART_TRAILING_ZERO_MONTHS_KEPT = 3;

/**
 * Same rule as client `trailingZeroTailClipStartIndex` on ascending monthly closes: more than
 * `monthsKept` consecutive zero balances at the **end** of the series → inactive for strip / nav.
 */
export function chartInactiveFromMonthlyClosingAsc(
  closingValuesAsc: readonly number[],
  monthsKept = CHART_TRAILING_ZERO_MONTHS_KEPT
): boolean {
  let lastNonZeroIdx = -1;
  for (let i = 0; i < closingValuesAsc.length; i++) {
    const v = closingValuesAsc[i];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 1e-9) {
      lastNonZeroIdx = i;
    }
  }
  const n = closingValuesAsc.length;
  const trailingLen = lastNonZeroIdx >= 0 ? n - 1 - lastNonZeroIdx : n;
  return trailingLen > monthsKept;
}

/**
 * True when the account’s monthly performance closes show a long zero tail (chart tail-clip rule).
 * No monthly series → not flagged inactive (insufficient data).
 */
export function accountChartInactive(accountId: number): boolean {
  const perf = getAccountMonthlyPerformance(accountId, "clp");
  if (!perf?.monthly.length) return false;
  const asc = [...perf.monthly].reverse();
  const closing = asc.map((r) => r.closing_value);
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}
