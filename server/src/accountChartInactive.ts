import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { db } from "./db.js";
import { withoutLiveDependencies } from "./cacheDependencies.js";
import {
  CHART_TRAILING_ZERO_MONTHS_KEPT,
  chartInactiveFromMonthlyClosingAsc,
} from "./accountValuationTailInactive.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

export {
  CHART_TRAILING_ZERO_MONTHS_KEPT,
  chartInactiveFromMonthlyClosingAsc,
  accountInactiveByValuationTail,
} from "./accountValuationTailInactive.js";

/**
 * Month-end closes for tail-inactive detection: the account's monthly performance rows
 * (`monthlyPerfForAccountId` — ledger cash reads its balance walk there), else stored
 * valuations, else today's mark (an account with no movement bounds and no valuation rows).
 */
function monthEndClosingAscForInactiveCheck(accountId: number): number[] {
  const perf = monthlyPerfForAccountId(accountId, "clp");
  if (perf?.monthly.length) {
    return [...perf.monthly].reverse().map((r) => r.closing_value);
  }
  const stored = loadBookValuationsAsc(accountId).map((r) => r.value_clp);
  if (stored.length) return stored;
  const mark = accountMarkClpAtYmd(accountId, chileCalendarTodayYmd());
  return mark ? [mark.value_clp] : [];
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
  // Whether the closes ended in zeros cannot move with a live price (always positive, it only
  // multiplies the units held), so a nav tree built on this answer does not depend on the
  // prices it read: a coin moving at night must not drop every group payload that lists accounts.
  const closing = withoutLiveDependencies(() => monthEndClosingAscForInactiveCheck(accountId));
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}

/** Nav bucket/group is inactive when every account in the subtree is inactive (empty → inactive). */
export function navBucketChartInactive(accountIds: readonly number[]): boolean {
  if (!accountIds.length) return true;
  return accountIds.every((id) => accountChartInactive(id));
}
