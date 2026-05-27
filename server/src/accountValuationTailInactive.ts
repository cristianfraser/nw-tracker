import { loadBookValuationsAsc } from "./bookValuations.js";

/**
 * Matches client {@link DEFAULT_TRAILING_ZERO_MONTHS_KEPT}: months of trailing **zero** balance
 * kept at the end of the monthly closing series before the rest is treated as inactive tail.
 */
export const CHART_TRAILING_ZERO_MONTHS_KEPT = 3;

/**
 * Same rule as client `trailingZeroTailClipStartIndex` on ascending monthly closes: more than
 * `monthsKept` consecutive zero balances at the **end** of the series → inactive tail.
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
 * Trailing-zero tail on stored month-end `valuations` only (no performance series).
 * Safe to import from credit-card billing modules without pulling in `accountPerformance`.
 */
export function accountInactiveByValuationTail(accountId: number): boolean {
  const closing = loadBookValuationsAsc(accountId).map((r) => r.value_clp);
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}
