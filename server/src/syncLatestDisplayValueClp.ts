import { liveAfpDisplayValueClp, liveFintualCertDisplayValueClp } from "./accountPosition.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClpDisplaySync,
} from "./brokerageEquityMtm.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { deptoAccountMarkClpAtYmd } from "./deptoDividendosLedger.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClpDisplaySync,
} from "./cryptoValuation.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";
import { usdCashBalanceLive } from "./usdCashAccounts.js";
import { latestCreditCardBillingBalanceTotalClpAndAsOfDate } from "./ccCreditCardValuations.js";
import {
  latestDisplayedBalanceForAccount,
  latestMortgageDisplayedBalance,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";

/** Sync latest CLP mark for pie charts (parity with dashboard cards / line live point). */
export function syncLatestDisplayValueClp(
  accountId: number,
  categorySlug?: string | null,
  opts?: { notes?: string | null; name?: string | null }
): { value_clp: number; as_of_date: string } | null {
  if (opts?.notes && isFintualCertV2ValuationNotes(opts.notes)) {
    const live = liveFintualCertDisplayValueClp(accountId, opts.notes, opts.name ?? null);
    if (live) return live;
  }
  if (categorySlug && isMovementBalanceCashCategory(categorySlug)) {
    return checkingMovementBalanceLive(accountId);
  }
  if (categorySlug && isUsdCashKindSlug(categorySlug)) {
    const live = usdCashBalanceLive(accountId);
    return { value_clp: live.value_clp, as_of_date: live.as_of_date };
  }
  if (accountUsesEquityMtm(accountId)) {
    const eq = computeEquityMtmClpDisplaySync(accountId);
    if (eq != null) return eq;
  }
  if (accountUsesCryptoMtm(accountId)) {
    const crypto = computeCryptoMtmClpDisplaySync(accountId);
    if (crypto != null) return crypto;
  }
  const stored = latestDisplayedBalanceForAccount(accountId);
  if (stored?.value_clp != null && stored.value_clp > 0 && stored.as_of_date) {
    return { value_clp: stored.value_clp, as_of_date: stored.as_of_date };
  }
  if (categorySlug === "afp") {
    const live = liveAfpDisplayValueClp(accountId);
    if (live) return live;
  }
  if (categorySlug === "credit_card") {
    const v = latestCreditCardBillingBalanceTotalClpAndAsOfDate(accountId);
    if (v?.value_clp != null && v.as_of_date) {
      return { value_clp: v.value_clp, as_of_date: v.as_of_date };
    }
  }
  if (categorySlug) {
    const kind = accountBucketKindSlug(categorySlug);
    if (kind === "property" || kind === "mortgage") {
      const today = chileCalendarTodayYmd();
      const depto = deptoAccountMarkClpAtYmd(kind, today);
      if (depto) return depto;
      if (kind === "mortgage") {
        const v = latestMortgageDisplayedBalance(accountId);
        if (v?.value_clp != null && v.as_of_date) {
          return { value_clp: v.value_clp, as_of_date: v.as_of_date };
        }
      }
    }
  }
  const vrow = latestValuationRowOnOrBeforeChileToday(accountId);
  if (vrow?.value_clp != null && vrow.as_of_date) {
    return { value_clp: vrow.value_clp, as_of_date: vrow.as_of_date };
  }
  return null;
}
