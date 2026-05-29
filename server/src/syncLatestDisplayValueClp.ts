import {
  liveAfpDisplayValueClp,
  liveFintualCertDisplayValueClp,
  readSpyVeaShareUnitsFromStocksCsv,
} from "./accountPosition.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeEquityMtmClpCachedLive,
  equityTickerForAccount,
} from "./brokerageEquityMtm.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { accountUsesCryptoMtm, computeCryptoMtmClp, cryptoEquityTickerForAccount } from "./cryptoValuation.js";
import { db } from "./db.js";
import { equityCloseUsdEod, equitySessionYmdForTicker } from "./equityQuote.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { latestCreditCardBillingBalanceTotalClpAndAsOfDate } from "./ccCreditCardValuations.js";
import {
  latestDisplayedBalanceForAccount,
  latestMortgageDisplayedBalance,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";

const stmtMaxEqDate = db.prepare(
  `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
);

function syncEquityDisplayValueClp(accountId: number): { value_clp: number; as_of_date: string } | null {
  const today = chileCalendarTodayYmd();
  const cached = computeEquityMtmClpCachedLive(accountId);
  if (cached != null && Number.isFinite(cached) && cached > 0) {
    return { value_clp: cached, as_of_date: today };
  }

  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;

  const session = equitySessionYmdForTicker(ticker);
  const fromSession = computeEquityMtmClp(accountId, session);
  if (fromSession != null && Number.isFinite(fromSession) && fromSession > 0) {
    return { value_clp: fromSession, as_of_date: session };
  }

  const mdRow = stmtMaxEqDate.get(ticker) as { md: string | null } | undefined;
  const md = mdRow?.md;
  if (md) {
    const fromEod = computeEquityMtmClp(accountId, md);
    if (fromEod != null && Number.isFinite(fromEod) && fromEod > 0) {
      return { value_clp: fromEod, as_of_date: md };
    }
  }

  if (ticker === "SPY" || ticker === "VEA") {
    const slug = ticker === "SPY" ? "spy" : "vea";
    const u = readSpyVeaShareUnitsFromStocksCsv(slug);
    if (u != null && Number.isFinite(u) && u > 0 && md) {
      const closeUsd = equityCloseUsdEod(ticker, md);
      if (closeUsd != null) {
        const fx = fxMonthEndForBalanceUsd(md);
        if (fx && fx.clp_per_usd > 0) {
          const clp = u * closeUsd * fx.clp_per_usd;
          if (Number.isFinite(clp) && clp > 0) {
            return { value_clp: clp, as_of_date: md };
          }
        }
      }
    }
  }

  return null;
}

function syncCryptoDisplayValueClp(accountId: number): { value_clp: number; as_of_date: string } | null {
  const t = cryptoEquityTickerForAccount(accountId);
  if (!t) return null;
  const mdRow = stmtMaxEqDate.get(t) as { md: string | null } | undefined;
  const md = mdRow?.md;
  if (!md) return null;
  const c = computeCryptoMtmClp(accountId, md);
  if (c == null || !Number.isFinite(c) || c <= 0) return null;
  return { value_clp: c, as_of_date: md };
}

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
  if (accountUsesEquityMtm(accountId)) {
    const eq = syncEquityDisplayValueClp(accountId);
    if (eq != null) return eq;
  }
  if (accountUsesCryptoMtm(accountId)) {
    const crypto = syncCryptoDisplayValueClp(accountId);
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
  if (categorySlug === "mortgage") {
    const v = latestMortgageDisplayedBalance(accountId);
    if (v?.value_clp != null && v.as_of_date) {
      return { value_clp: v.value_clp, as_of_date: v.as_of_date };
    }
  }
  const vrow = latestValuationRowOnOrBeforeChileToday(accountId);
  if (vrow?.value_clp != null && vrow.as_of_date) {
    return { value_clp: vrow.value_clp, as_of_date: vrow.as_of_date };
  }
  return null;
}
