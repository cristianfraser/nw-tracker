import { resolveOperationalAccountId } from "./accountSource.js";
import { ccInstallmentLedgerRowCount } from "./ccInstallmentLedgerDb.js";
import { creditCardBillingBalanceTotalClpAsOf } from "./ccCreditCardValuations.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  deptoMortgageCloseClpBySnapshotDates,
  firstDeptoPropertyOwnershipYmd,
  loadDeptoDividendosSheetLedger,
} from "./deptoDividendosLedger.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";

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
  `SELECT g.slug AS bucket_slug FROM accounts a
   JOIN asset_groups g ON g.id = a.asset_group_id
   WHERE a.id = ?`
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
 * Credit-card balance for display: **balance total** (same as account detail) when ledger + billing exist;
 * otherwise stored valuations.
 */
export function latestCreditCardDisplayedBalance(
  accountId: number,
  asOfYmd: string = chileCalendarTodayYmd()
): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const today = chileCalendarTodayYmd();
  if (asOfYmd >= today && ccInstallmentLedgerRowCount(accountId) > 0) {
    const live = creditCardBillingBalanceTotalClpAsOf(accountId, asOfYmd);
    if (live && Number.isFinite(live.value_clp)) {
      return {
        value_clp: live.value_clp,
        as_of_date: live.as_of_date,
      };
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

/**
 * Mortgage balance for display: **crédito restante** from `depto-dividendos.csv` (UF × UF día),
 * same as account detail and {@link liabilitiesBreakdownClpAsOf} with `mortgageFromDeptoSheet`.
 */
export function latestMortgageDisplayedBalance(
  accountId: number,
  asOfYmd: string = chileCalendarTodayYmd()
): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const effectiveId = resolveOperationalAccountId(accountId);
  const cat = stmtCategorySlug.get(effectiveId) as { bucket_slug: string } | undefined;
  if (!cat || accountBucketKindSlug(cat.bucket_slug) !== "mortgage") {
    return latestValuationRowOnOrBefore(effectiveId, asOfYmd);
  }
  const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
  if (ledger.length > 0) {
    const firstOwn = firstDeptoPropertyOwnershipYmd(ledger);
    if (firstOwn != null && asOfYmd >= firstOwn) {
      const ufMap = ufClpBySnapshotDatesAsc([asOfYmd]);
      const close = deptoMortgageCloseClpBySnapshotDates([asOfYmd], ledger, ufMap).get(asOfYmd);
      if (close != null && Number.isFinite(close)) {
        return { value_clp: close, as_of_date: asOfYmd };
      }
    }
  }
  return latestValuationRowOnOrBefore(effectiveId, asOfYmd);
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
  if (categorySlug === "mortgage") {
    return latestMortgageDisplayedBalance(effectiveId, asOfYmd);
  }
  return latestValuationRowOnOrBefore(effectiveId, asOfYmd);
}

/** Latest displayed balance respecting account category (credit card → live ledger, mortgage → sheet). */
export function latestDisplayedBalanceForAccount(accountId: number): LatestValuationRow | undefined {
  if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
  const effectiveId = resolveOperationalAccountId(accountId);
  const cat = stmtCategorySlug.get(effectiveId) as { bucket_slug: string } | undefined;
  const kind = cat ? accountBucketKindSlug(cat.bucket_slug) : "";
  if (kind === "credit_card") {
    return latestCreditCardDisplayedBalance(effectiveId, chileCalendarTodayYmd());
  }
  if (kind === "mortgage") {
    return latestMortgageDisplayedBalance(effectiveId, chileCalendarTodayYmd());
  }
  return latestValuationRowOnOrBeforeChileToday(effectiveId);
}
