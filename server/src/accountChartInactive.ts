import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { db } from "./db.js";
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

/** Credit-card masters: never tail-inactive (installment projections + retired cards). */
function isCreditCardChartAccount(accountId: number): boolean {
  const slug = bucketSlugForAccountId(accountId);
  if (slug != null && accountBucketKindSlug(slug) === "credit_card") return true;
  const row = db
    .prepare(`SELECT import_key FROM accounts WHERE id = ?`)
    .get(accountId) as { import_key: string | null } | undefined;
  return String(row?.import_key ?? "").startsWith("credit_card_master|");
}

/**
 * True when month-end closes show a long trailing-zero tail (chart tail-clip rule).
 * Uses performance closes when available; otherwise stored `valuations`.
 */
export function accountChartInactive(accountId: number): boolean {
  if (isCreditCardChartAccount(accountId)) return false;
  const closing = monthEndClosingAscForInactiveCheck(accountId);
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}

/** Nav bucket/group is inactive when every account in the subtree is inactive (empty → inactive). */
export function navBucketChartInactive(accountIds: readonly number[]): boolean {
  if (!accountIds.length) return true;
  return accountIds.every((id) => accountChartInactive(id));
}
