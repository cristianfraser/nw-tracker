import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { db } from "./db.js";
import {
  CHART_TRAILING_ZERO_MONTHS_KEPT,
  chartInactiveFromMonthlyClosingAsc,
  accountInactiveByValuationTail,
} from "./accountValuationTailInactive.js";
import { loadBookValuationsAsc } from "./bookValuations.js";

export {
  CHART_TRAILING_ZERO_MONTHS_KEPT,
  chartInactiveFromMonthlyClosingAsc,
  accountInactiveByValuationTail,
} from "./accountValuationTailInactive.js";

/** Month-end closes for tail-inactive detection (performance series, else stored valuations). */
function monthEndClosingAscForInactiveCheck(accountId: number): number[] {
  const perf = getAccountMonthlyPerformance(accountId, "clp");
  if (perf?.monthly.length) {
    return [...perf.monthly].reverse().map((r) => r.closing_value);
  }
  return loadBookValuationsAsc(accountId).map((r) => r.value_clp);
}

/** Per-card Santander masters stay in sidebar/group charts even when balance is currently $0. */
function isRegisteredCreditCardMaster(accountId: number): boolean {
  const hit = db
    .prepare(
      `SELECT 1 AS o FROM credit_card_group_items
       WHERE account_id = ? AND item_kind = 'account'
       LIMIT 1`
    )
    .get(accountId) as { o: number } | undefined;
  return hit != null;
}

/**
 * True when month-end closes show a long trailing-zero tail (chart tail-clip rule).
 * Uses performance closes when available; otherwise stored `valuations` (e.g. cash accounts
 * that skip monthly P/L but still have month-end book balances).
 */
export function accountChartInactive(accountId: number): boolean {
  if (isRegisteredCreditCardMaster(accountId)) return false;
  const closing = monthEndClosingAscForInactiveCheck(accountId);
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}
