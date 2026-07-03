import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { getAccountSourceRow } from "./accountSource.js";
import {
  CHART_TRAILING_ZERO_MONTHS_KEPT,
  chartInactiveFromMonthlyClosingAsc,
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

/** Operational master id for inactivity (liability_view CC rows use master valuations). */
export function accountIdForInactiveCheck(accountId: number): number {
  const row = getAccountSourceRow(accountId);
  if (row?.account_kind === "liability_view" && row.source_account_id != null) {
    return row.source_account_id;
  }
  return accountId;
}

/** Credit-card masters/views: never tail-inactive (installment projections + retired cards). */
function isCreditCardChartAccount(accountId: number): boolean {
  const effectiveId = accountIdForInactiveCheck(accountId);
  const slug = bucketSlugForAccountId(effectiveId);
  if (slug != null && accountBucketKindSlug(slug) === "credit_card") return true;
  const row = getAccountSourceRow(effectiveId);
  return String(row?.notes ?? "").startsWith("credit_card_master|");
}

/**
 * True when month-end closes show a long trailing-zero tail (chart tail-clip rule).
 * Uses performance closes when available; otherwise stored `valuations`.
 */
export function accountChartInactive(accountId: number): boolean {
  if (isCreditCardChartAccount(accountId)) return false;
  const effectiveId = accountIdForInactiveCheck(accountId);
  const closing = monthEndClosingAscForInactiveCheck(effectiveId);
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}

/** Nav bucket/group is inactive when every account in the subtree is inactive (empty → inactive). */
export function navBucketChartInactive(accountIds: readonly number[]): boolean {
  if (!accountIds.length) return true;
  return accountIds.every((id) => accountChartInactive(id));
}
