import { resolveOperationalAccountId } from "./accountSource.js";
import { liveCreditCardOutstandingClp, ccInstallmentLedgerRowCount } from "./ccInstallmentLedgerDb.js";
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

const stmtCategorySlug = db.prepare(
  `SELECT c.slug AS category_slug FROM accounts a
   JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
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
 * Credit-card balance for display: live ledger outstanding when available (never a future month-end).
 */
export function latestCreditCardDisplayedBalance(
  accountId: number,
  asOfYmd: string = chileCalendarTodayYmd()
): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const today = chileCalendarTodayYmd();
  if (asOfYmd >= today && ccInstallmentLedgerRowCount(accountId) > 0) {
    const live = liveCreditCardOutstandingClp(accountId);
    if (live != null && Number.isFinite(live)) {
      return { value_clp: live, as_of_date: today };
    }
  }
  return latestValuationRowOnOrBefore(accountId, asOfYmd);
}

/**
 * Credit-card valuation as of a date: on-or-before stored rows only; current dates use live ledger.
 */
export function latestCreditCardValuationRowAsOf(
  accountId: number,
  asOfYmd: string
): LatestValuationRow | undefined {
  return latestCreditCardDisplayedBalance(accountId, asOfYmd);
}

/** Pasivos snapshot for dashboard / breakdown (credit card uses live ledger when current). */
export function latestLiabilityValuationRowForSnapshot(
  accountId: number,
  categorySlug: string,
  asOfYmd: string
): LatestValuationRow | undefined {
  const effectiveId = resolveOperationalAccountId(accountId);
  if (categorySlug === "credit_card") {
    return latestCreditCardDisplayedBalance(effectiveId, asOfYmd);
  }
  return latestValuationRowOnOrBefore(effectiveId, asOfYmd);
}

/** Latest displayed balance respecting account category (credit card → live ledger). */
export function latestDisplayedBalanceForAccount(accountId: number): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const effectiveId = resolveOperationalAccountId(accountId);
  const cat = stmtCategorySlug.get(effectiveId) as { category_slug: string } | undefined;
  if (cat?.category_slug === "credit_card") {
    return latestCreditCardDisplayedBalance(effectiveId, chileCalendarTodayYmd());
  }
  return latestValuationRowOnOrBeforeChileToday(effectiveId);
}
