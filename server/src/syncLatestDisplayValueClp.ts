import { liveAfpDisplayValueClp, liveFintualCertDisplayValueClp } from "./accountPosition.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClpDisplaySync,
} from "./brokerageEquityMtm.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountBucketKindSlug, accountKindSlugForAccountId } from "./accountBucket.js";
import { resolveOperationalAccountId } from "./accountSource.js";
import { storedMarkValueWithFlowCarry } from "./storedMarkFlowCarry.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClpDisplaySync,
} from "./cryptoValuation.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";
import { usdCashBalanceLive } from "./usdCashAccounts.js";
import { isClpCashKindSlug, clpCashBalanceLive } from "./clpCashAccounts.js";
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
  opts?: { import_key?: string | null; name?: string | null }
): { value_clp: number; as_of_date: string } | null {
  if (opts?.import_key && isFintualCertV2ValuationNotes(opts.import_key)) {
    const live = liveFintualCertDisplayValueClp(accountId, opts.import_key, opts.name ?? null);
    if (live) return live;
  }
  if (categorySlug && isMovementBalanceCashCategory(categorySlug)) {
    return checkingMovementBalanceLive(accountId);
  }
  const bucketKind = categorySlug ? accountBucketKindSlug(categorySlug) : "";
  if (bucketKind && isUsdCashKindSlug(bucketKind)) {
    const live = usdCashBalanceLive(accountId);
    return { value_clp: live.value_clp, as_of_date: live.as_of_date };
  }
  if (bucketKind && isClpCashKindSlug(bucketKind)) {
    return clpCashBalanceLive(accountId);
  }
  if (accountUsesEquityMtm(accountId)) {
    const eq = computeEquityMtmClpDisplaySync(accountId);
    if (eq != null) return eq;
  }
  if (accountUsesCryptoMtm(accountId)) {
    const crypto = computeCryptoMtmClpDisplaySync(accountId);
    if (crypto != null) return crypto;
  }
  // Depto UF marks beat stored valuations for property/mortgage (same order as the
  // `accountMarkClpAtYmd` today branch) — a stale property valuation must not shadow the
  // live ledger mark in pies/live points.
  if (categorySlug) {
    const kind = accountBucketKindSlug(categorySlug);
    if (kind === "property" || kind === "mortgage") {
      const depto = deptoAccountMarkClpAtYmd(kind, chileCalendarTodayYmd());
      if (depto) return depto;
      if (kind === "mortgage") {
        const v = latestMortgageDisplayedBalance(accountId);
        if (v?.value_clp != null && v.as_of_date) {
          return { value_clp: v.value_clp, as_of_date: v.as_of_date };
        }
      }
    }
  }
  const stored = latestDisplayedBalanceForAccount(accountId);
  if (stored?.value_clp != null && stored.value_clp > 0 && stored.as_of_date) {
    // Book-value carry for manual-marked accounts: stale mark + net personal flows since its
    // date, so a deposit entered today moves today's value (daily/monthly pl 0, not −flow).
    // CC/mortgage displayed balances are their own derivations — never carried.
    const effectiveId = resolveOperationalAccountId(accountId);
    const kind = accountKindSlugForAccountId(effectiveId) ?? "";
    const value_clp =
      kind === "credit_card" || kind === "mortgage"
        ? stored.value_clp
        : storedMarkValueWithFlowCarry(
            effectiveId,
            stored.value_clp,
            stored.as_of_date,
            chileCalendarTodayYmd()
          );
    return { value_clp, as_of_date: stored.as_of_date };
  }
  if (bucketKind === "afp") {
    const live = liveAfpDisplayValueClp(accountId);
    if (live) return live;
  }
  if (bucketKind === "credit_card") {
    const v = latestCreditCardBillingBalanceTotalClpAndAsOfDate(accountId);
    if (v?.value_clp != null && v.as_of_date) {
      return { value_clp: v.value_clp, as_of_date: v.as_of_date };
    }
  }
  const vrow = latestValuationRowOnOrBeforeChileToday(accountId);
  if (vrow?.value_clp != null && vrow.as_of_date) {
    const kind = accountKindSlugForAccountId(accountId) ?? "";
    const value_clp =
      kind === "credit_card" || kind === "mortgage"
        ? vrow.value_clp
        : storedMarkValueWithFlowCarry(accountId, vrow.value_clp, vrow.as_of_date, chileCalendarTodayYmd());
    return { value_clp, as_of_date: vrow.as_of_date };
  }
  return null;
}
