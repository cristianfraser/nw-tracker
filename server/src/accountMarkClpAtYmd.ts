import {
  liveAfpDisplayValueClp,
  liveFintualCertDisplayValueClp,
} from "./accountPosition.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  equityShareUnitsThroughYmd,
} from "./brokerageEquityMtm.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";
import { accountUsesCryptoMtm, computeCryptoMtmClp } from "./cryptoValuation.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashAccount, usdCashBalanceClpAt } from "./usdCashAccounts.js";
import { isClpCashAccount, clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { syncLatestDisplayValueClp } from "./syncLatestDisplayValueClp.js";
import { db } from "./db.js";
import { creditCardBillingBalanceTotalClpAsOf } from "./ccCreditCardValuations.js";
import { latestMortgageDisplayedBalance } from "./valuationLatest.js";

export type AccountMarkAtYmd = { value_clp: number; as_of_date: string };

function deptoKindForBucketSlug(bucketSlug: string): "property" | "mortgage" | null {
  const kind = accountBucketKindSlug(bucketSlug);
  if (kind === "property" || kind === "mortgage") return kind;
  return null;
}

function bucketSlugForAccount(accountId: number): string | null {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  return row?.bucket_slug ?? null;
}

function historicalMarkClpAtYmd(
  accountId: number,
  asOfYmd: string,
  categorySlug: string,
  opts?: { notes?: string | null; name?: string | null }
): AccountMarkAtYmd | null {
  if (accountBucketKindSlug(categorySlug) === "afp") {
    const live = liveAfpDisplayValueClp(accountId, asOfYmd);
    if (live) return live;
  }
  if (opts?.notes && isFintualCertV2ValuationNotes(opts.notes)) {
    const live = liveFintualCertDisplayValueClp(accountId, opts.notes, opts.name ?? null, asOfYmd);
    if (live) return live;
  }
  if (isMovementBalanceCashCategory(categorySlug)) {
    const clp = checkingMovementBalanceClpAtCached(accountId, asOfYmd);
    if (Number.isFinite(clp)) return { value_clp: clp, as_of_date: asOfYmd };
  }
  if (isUsdCashAccount(accountId)) {
    const clp = usdCashBalanceClpAt(accountId, asOfYmd);
    if (Number.isFinite(clp)) return { value_clp: clp, as_of_date: asOfYmd };
  }
  if (isClpCashAccount(accountId)) {
    const clp = clpCashBalanceClpAt(accountId, asOfYmd);
    if (Number.isFinite(clp)) return { value_clp: clp, as_of_date: asOfYmd };
  }
  if (accountUsesEquityMtm(accountId)) {
    const clp = computeEquityMtmClp(accountId, asOfYmd);
    if (clp != null && Number.isFinite(clp)) return { value_clp: clp, as_of_date: asOfYmd };
    if (equityShareUnitsThroughYmd(accountId, asOfYmd) <= 0) {
      return { value_clp: 0, as_of_date: asOfYmd };
    }
  }
  if (accountUsesCryptoMtm(accountId)) {
    const clp = computeCryptoMtmClp(accountId, asOfYmd);
    if (clp != null && Number.isFinite(clp)) return { value_clp: clp, as_of_date: asOfYmd };
  }
  const deptoKind = deptoKindForBucketSlug(categorySlug);
  if (deptoKind) {
    const depto = deptoAccountMarkClpAtYmd(deptoKind, asOfYmd);
    if (depto) return depto;
    if (deptoKind === "mortgage") {
      const v = latestMortgageDisplayedBalance(accountId, asOfYmd);
      if (v?.value_clp != null && v.as_of_date && v.as_of_date <= asOfYmd) {
        return { value_clp: v.value_clp, as_of_date: v.as_of_date };
      }
    }
  }
  if (accountBucketKindSlug(categorySlug) === "credit_card") {
    const cc = creditCardBillingBalanceTotalClpAsOf(accountId, asOfYmd);
    if (cc?.value_clp != null && Number.isFinite(cc.value_clp)) {
      return { value_clp: cc.value_clp, as_of_date: cc.as_of_date };
    }
  }

  const stored = db
    .prepare(
      `SELECT as_of_date, value_clp FROM valuations
       WHERE account_id = ? AND as_of_date <= ?
       ORDER BY as_of_date DESC LIMIT 1`
    )
    .get(accountId, asOfYmd) as { as_of_date: string; value_clp: number } | undefined;
  if (stored?.value_clp != null && Number.isFinite(stored.value_clp)) {
    return { value_clp: stored.value_clp, as_of_date: stored.as_of_date };
  }

  return null;
}

/**
 * Account CLP mark at a calendar date: live stack when `asOfYmd` is Chile today, else historical marks
 * (UF día, cuotas×valor, MTM EOD, cartola balance, depto sheet) at that date — not “latest on file”.
 */
export function accountMarkClpAtYmd(
  accountId: number,
  asOfYmd: string,
  categorySlug?: string | null,
  opts?: { notes?: string | null; name?: string | null }
): AccountMarkAtYmd | null {
  const slug = categorySlug ?? bucketSlugForAccount(accountId) ?? "";
  const today = chileCalendarTodayYmd();

  if (asOfYmd === today) {
    const deptoKind = deptoKindForBucketSlug(slug);
    if (deptoKind) {
      const depto = deptoAccountMarkClpAtYmd(deptoKind, asOfYmd);
      if (depto) return depto;
    }
    const live = syncLatestDisplayValueClp(accountId, slug, opts);
    if (live) return live;
    return null;
  }

  return historicalMarkClpAtYmd(accountId, asOfYmd, slug, opts);
}
