import { resolveOperationalAccountId } from "./accountSource.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

export type LatestValuationRow = { value_clp: number; as_of_date: string };

const stmtOnOrBefore = db.prepare(
  `SELECT value_clp, as_of_date FROM valuations
   WHERE account_id = ? AND as_of_date <= ?
   ORDER BY as_of_date DESC LIMIT 1`
);

const stmtFallback = db.prepare(
  `SELECT value_clp, as_of_date FROM valuations
   WHERE account_id = ?
   ORDER BY as_of_date DESC LIMIT 1`
);

const stmtAtDate = db.prepare(
  `SELECT value_clp, as_of_date FROM valuations WHERE account_id = ? AND as_of_date = ?`
);

/** Latest valuation on or before `asOfYmd`. Returns `undefined` when the account has no history yet. */
export function latestValuationRowOnOrBefore(
  accountId: number,
  asOfYmd: string
): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  return stmtOnOrBefore.get(accountId, asOfYmd) as LatestValuationRow | undefined;
}

/**
 * Latest valuation on or before Chile today. Falls back to the absolute latest row only for the
 * current snapshot (e.g. account with only a future month-end placeholder).
 */
export function latestValuationRowOnOrBeforeChileToday(accountId: number): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const today = chileCalendarTodayYmd();
  const row = stmtOnOrBefore.get(accountId, today) as LatestValuationRow | undefined;
  if (row) return row;
  return stmtFallback.get(accountId) as LatestValuationRow | undefined;
}

/**
 * Credit-card statement closes are stored at calendar month-end. Mid-month, that date is after
 * `asOfYmd` but should still be the displayed balance (same as liabilities chart
 * {@link sanitizeValuationChartDateStrs} in valuationTimeseries).
 */
export function latestCreditCardValuationRowAsOf(
  accountId: number,
  asOfYmd: string
): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const monthEnd = monthEndUtcYmd(monthKeyFromYmd(asOfYmd));
  if (monthEnd > asOfYmd) {
    const atClose = stmtAtDate.get(accountId, monthEnd) as LatestValuationRow | undefined;
    if (atClose) return atClose;
  }
  const onOrBefore = latestValuationRowOnOrBefore(accountId, asOfYmd);
  if (onOrBefore) return onOrBefore;
  if (asOfYmd === chileCalendarTodayYmd()) {
    return stmtFallback.get(accountId) as LatestValuationRow | undefined;
  }
  return undefined;
}

/** Pasivos snapshot for dashboard / breakdown (credit card uses {@link latestCreditCardValuationRowAsOf}). */
export function latestLiabilityValuationRowForSnapshot(
  accountId: number,
  categorySlug: string,
  asOfYmd: string
): LatestValuationRow | undefined {
  const effectiveId = resolveOperationalAccountId(accountId);
  if (categorySlug === "credit_card") {
    return latestCreditCardValuationRowAsOf(effectiveId, asOfYmd);
  }
  return latestValuationRowOnOrBefore(effectiveId, asOfYmd);
}
