import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import {
  ccInstallmentLedgerRowCount,
  ccLedgerMonthEndIso,
  cupoEnCuotasClpForCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";

const upsertValuationMonth = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value_clp)
  VALUES (@account_id, @as_of_date, @value_clp)
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp
`);

/** Latest billing-detail balance total (facturado + cupo − cuota próxima), same as account «Balance total». */
export function latestCreditCardBillingBalanceTotalClp(accountId: number): number | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  if (detail.length === 0) return null;
  const v = detail[0]!.balance_total_clp;
  return Number.isFinite(v) ? Math.round(v) : null;
}

export function latestCreditCardBillingBalanceTotalClpAndAsOfDate(
  accountId: number
): { value_clp: number; as_of_date: string } | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  if (detail.length === 0) return null;
  const row = detail[0]!;
  if (!Number.isFinite(row.balance_total_clp)) return null;
  return {
    value_clp: Math.round(row.balance_total_clp),
    as_of_date: row.as_of_date,
  };
}

/**
 * Billing-detail balance total as of a calendar date.
 * Uses the latest `billing_month` <= month(`asOfYmd`) to avoid pulling future-filled months.
 */
export function creditCardBillingBalanceTotalClpAsOf(
  accountId: number,
  asOfYmd: string
): { value_clp: number; as_of_date: string } | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const asOfMonth = monthKeyFromYmd(asOfYmd);
  if (!asOfMonth) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  if (detail.length === 0) return null;
  const row = detail.find((r) => r.billing_month <= asOfMonth);
  if (!row || !Number.isFinite(row.balance_total_clp)) return null;
  return {
    value_clp: Math.round(row.balance_total_clp),
    as_of_date: row.as_of_date,
  };
}

/**
 * Month-end valuation points: **balance total** per billing month (Detalle por mes / summary card),
 * not cupo en cuotas alone. Falls back to ledger cupo when no billing row exists for that month.
 */
export function ccLedgerStatementClosingPointsClp(
  accountId: number
): { as_of_date: string; value_clp: number }[] | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { months: ledgerMonths, detail } = billingDetailCacheForAccount(accountId);
  const balanceByMonth = new Map(detail.map((d) => [d.billing_month, d.balance_total_clp]));
  const months = [
    ...new Set([
      ...ledgerMonths.map((h) => h.month),
      ...balanceByMonth.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  if (months.length === 0) return null;
  return months.map((ym) => ({
    as_of_date: ccLedgerMonthEndIso(ym),
    value_clp: Math.round(
      balanceByMonth.get(ym) ?? cupoEnCuotasClpForCalendarMonth(accountId, ym)
    ),
  }));
}

/** Ledger month-end closes for many CC accounts (one billing-detail cache pass per account). */
export function ccLedgerStatementClosingPointsClpForAccounts(
  accountIds: readonly number[]
): Map<number, { as_of_date: string; value_clp: number }[]> {
  const out = new Map<number, { as_of_date: string; value_clp: number }[]>();
  for (const id of accountIds) {
    const pts = ccLedgerStatementClosingPointsClp(id);
    if (pts?.length) out.set(id, pts);
  }
  return out;
}

/**
 * Persists month-end `valuations` aligned with credit-card **balance total** (not cupo-only).
 * Run after ledger + billing recompute so dashboard / charts match account detail.
 */
export function upsertCreditCardValuationsFromLedger(accountId: number): number {
  const pts = ccLedgerStatementClosingPointsClp(accountId);
  if (!pts || pts.length === 0) return 0;
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row || accountBucketKindSlug(row.bucket_slug) !== "credit_card") return 0;
  let n = 0;
  for (const p of pts) {
    upsertValuationMonth.run({
      account_id: accountId,
      as_of_date: p.as_of_date,
      value_clp: p.value_clp,
    });
    n += 1;
  }
  const today = chileCalendarTodayYmd();
  const liveBalance = latestCreditCardBillingBalanceTotalClp(accountId);
  const liveToday =
    liveBalance != null && Number.isFinite(liveBalance)
      ? liveBalance
      : liveCreditCardOutstandingClp(accountId);
  if (liveToday != null && Number.isFinite(liveToday)) {
    upsertValuationMonth.run({
      account_id: accountId,
      as_of_date: today,
      value_clp: liveToday,
    });
    n += 1;
    invalidateAggregationForAccountDate(accountId, today);
  }
  if (pts.length > 0) {
    invalidateAggregationForAccountDate(accountId, pts[0]!.as_of_date);
  }
  return n;
}
