import {
  invalidateAggregationForAccountDate,
  invalidateCcBillingDetail,
} from "./aggregationCache.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  ccInstallmentLedgerRowCount,
  ccLedgerMonthEndIso,
  cupoEnCuotasClpForCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";

const upsertValuationMonth = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value, currency)
  VALUES (@account_id, @as_of_date, @value_clp, 'clp')
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency
`);

/**
 * Latest billing-detail balance total (open month rolled balance), same as account «Balance total».
 * detail is sorted descending and includes plan-only projected future rows — skip those (their
 * saldo is the remaining-cuotas projection, not the live rolled balance). The +1 cutoff covers
 * the gap right after a cierre when the open month is the next calendar month.
 */
function latestBillingDetailRow(
  detail: ReturnType<typeof billingDetailCacheForAccount>["detail"]
): (typeof detail)[0] | undefined {
  const todayYm = chileCalendarTodayYmd().slice(0, 7);
  const cutoff = addCalendarMonths(todayYm, 1);
  return detail.find((r) => !r.projected && r.billing_month <= cutoff);
}

export function latestCreditCardBillingBalanceTotalClp(accountId: number): number | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  const row = latestBillingDetailRow(detail);
  if (!row || !Number.isFinite(row.balance_total_clp)) return null;
  return Math.round(row.balance_total_clp);
}

export function latestCreditCardBillingBalanceTotalClpAndAsOfDate(
  accountId: number
): { value_clp: number; as_of_date: string } | null {
  if (ccInstallmentLedgerRowCount(accountId) === 0) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  const row = latestBillingDetailRow(detail);
  if (!row || !Number.isFinite(row.balance_total_clp)) return null;
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
  const { payload, detail } = billingDetailCacheForAccount(accountId);
  if (payload == null) {
    throw new Error(`account ${accountId}: ledger rows exist but cached bundle has no payload`);
  }
  const ledgerMonths = payload.months;
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

/** Last day of its own month (the shape every statement-derived anchor is written on). */
function isMonthEndIso(ymd: string): boolean {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t + 86_400_000).toISOString().slice(8, 10) === "01";
}

/**
 * Delete the daily "today" stamps that newly-imported evidence contradicts: rows dated from
 * the earliest affected transaction date through yesterday.
 *
 * Those stamps froze the live formula on the day they were written, so a statement or manual
 * contract imported later — carrying transaction dates BEFORE them — leaves them asserting a
 * balance that provably predates the evidence. The owed walk would climb through the new
 * purchases and then snap back down to the stale stamp, and the whole import would land in
 * "today's" delta instead of on the days it happened. A card's balance follows its evidence
 * dates; when the evidence arrived is not part of the model.
 *
 * Month-end rows are kept: they are statement-derived, and this same run recomputes them.
 * Returns the purged dates for the caller's import log.
 */
function purgeContradictedDailyStamps(
  accountId: number,
  fromYmd: string,
  todayYmd: string
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || fromYmd >= todayYmd) return [];
  const rows = db
    .prepare(
      `SELECT as_of_date FROM valuations
       WHERE account_id = ? AND as_of_date >= ? AND as_of_date < ?
       ORDER BY as_of_date`
    )
    .all(accountId, fromYmd, todayYmd) as { as_of_date: string }[];
  const stale = rows.map((r) => r.as_of_date).filter((d) => !isMonthEndIso(d));
  if (stale.length === 0) return [];
  const del = db.prepare(`DELETE FROM valuations WHERE account_id = ? AND as_of_date = ?`);
  for (const d of stale) del.run(accountId, d);
  invalidateAggregationForAccountDate(accountId, stale[0]!);
  return stale;
}

/**
 * Persists month-end `valuations` aligned with credit-card **balance total** (not cupo-only).
 * Run after ledger + billing recompute so dashboard / charts match account detail.
 *
 * `affectedEvidenceFromYmd`: earliest transaction date this write's evidence touched (new
 * statement lines, installment contracts, header payments, or the dates of removed ones).
 * Pass it from any caller that ADDED or REMOVED dated evidence so the stamps it contradicts
 * are purged (see {@link purgeContradictedDailyStamps}); pure recomputes omit it.
 */
export function upsertCreditCardValuationsFromLedger(
  accountId: number,
  opts?: { affectedEvidenceFromYmd?: string | null }
): number {
  // This runs after CC writes — drop the cached detail first so the points below (and every
  // later read) reflect the new ledger/statement state instead of a pre-write cache entry.
  invalidateCcBillingDetail(accountId);
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row || accountBucketKindSlug(row.bucket_slug) !== "credit_card") return 0;
  // Before the points check: dropping stamps the new evidence contradicts is about removing
  // wrong data, so it must happen even when this run has no month-end points to write.
  if (opts?.affectedEvidenceFromYmd) {
    purgeContradictedDailyStamps(accountId, opts.affectedEvidenceFromYmd, chileCalendarTodayYmd());
  }
  const pts = ccLedgerStatementClosingPointsClp(accountId);
  if (!pts || pts.length === 0) return 0;
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
