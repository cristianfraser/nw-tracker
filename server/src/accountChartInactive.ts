import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { db } from "./db.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { accountUsesEquityMtm, equityShareUnitsThroughYmd } from "./brokerageEquityMtm.js";
import { accountUsesCryptoMtm, cryptoCoinCumulativeThroughDate } from "./cryptoValuation.js";
import { cuotaLedgerSeriesKeyForAccount, isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
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

const stmtImportKey = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);
const stmtHasUnits = db.prepare(
  `SELECT 1 FROM movements
   WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?) AND COALESCE(units_delta, 0) != 0
   LIMIT 1`
);

/** Below this a holding is float residue of an emptied account (cuotas carry 4 decimals). */
const EMPTY_HOLDING_EPS = 1e-9;

/**
 * What the account holds today in its own unit, read from the ledger without any price: shares,
 * coins, fund cuotas, dollars. Null for an account valued some other way (a peso ledger, the
 * property, stored marks), whose month closes decide instead.
 */
function holdingTodayWithoutPrice(accountId: number): number | null {
  const today = chileCalendarTodayYmd();
  if (equityTickerForAccount(accountId) != null && accountUsesEquityMtm(accountId)) {
    return equityShareUnitsThroughYmd(accountId, today);
  }
  if (accountUsesCryptoMtm(accountId)) return cryptoCoinCumulativeThroughDate(accountId, today);
  const slug = bucketSlugForAccountId(accountId);
  const kindSlug = slug != null ? accountBucketKindSlug(slug) : "";
  const importKey = (stmtImportKey.get(accountId) as { import_key: string | null } | undefined)?.import_key ?? null;
  const cuotaLedger =
    isCuotaLedgerKindSlug(kindSlug) && cuotaLedgerSeriesKeyForAccount(accountId, kindSlug, today) != null;
  if ((cuotaLedger || isFintualCertV2ValuationNotes(importKey)) && stmtHasUnits.get(accountId, accountId, accountId)) {
    return fintualGoalUnitsFromMovementsThroughDate(accountId, today) ?? 0;
  }
  if (isUsdCashAccount(accountId)) return usdCashBalanceUsdAt(accountId, today);
  return null;
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
  // An account valued from units holds something exactly when it has units: the price only
  // multiplies them. Reading the units keeps the answer (and every nav tree built on it) free of
  // prices, and spares building the account's whole monthly series.
  const holding = holdingTodayWithoutPrice(accountId);
  if (holding != null) return !(Math.abs(holding) > EMPTY_HOLDING_EPS);
  const closing = monthEndClosingAscForInactiveCheck(accountId);
  if (!closing.length) return false;
  return chartInactiveFromMonthlyClosingAsc(closing, CHART_TRAILING_ZERO_MONTHS_KEPT);
}

/** Nav bucket/group is inactive when every account in the subtree is inactive (empty → inactive). */
export function navBucketChartInactive(accountIds: readonly number[]): boolean {
  if (!accountIds.length) return true;
  return accountIds.every((id) => accountChartInactive(id));
}
