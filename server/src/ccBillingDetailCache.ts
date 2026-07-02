import {
  cacheKeyCcBillingDetail,
  getAggregationCached,
  invalidateCcBillingDetail,
} from "./aggregationCache.js";
import { buildBillingDetailByMonth, type CcBillingDetailMonthRow } from "./ccBillingViews.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import type { CcInstallmentMonthRow } from "./creditCardInstallments.js";

type CachedBillingDetail = {
  months: CcInstallmentMonthRow[];
  detail: CcBillingDetailMonthRow[];
};

/**
 * Drop every cached ledger + detalle por mes entry. Entries live in the aggregation cache
 * (fresh per Chile day + external `data_version` bumps); same-connection CC writes invalidate
 * per account via `invalidateCcBillingDetail` — this full clear is for tests/tools only.
 */
export function clearCreditCardBillingDetailCache(): void {
  invalidateCcBillingDetail();
}

/** One `ccInstallmentsDbApiPayload` + `buildBillingDetailByMonth` per account per cache generation. */
export function billingDetailCacheForAccount(accountId: number): CachedBillingDetail {
  return getAggregationCached(cacheKeyCcBillingDetail(accountId), () => {
    const payload = ccInstallmentsDbApiPayload(accountId);
    // Build with the full history schedule (not payload.months, which is filtered to >= nowYm) so
    // cuota_a_pagar_next_mes_clp — and therefore balance_total_clp — is correct for past billing
    // months. Must match creditCardInstallmentsResponse so the valuation line matches the historial
    // chart / detalle por mes (db.months would leave past cuotaNext = 0, inflating closed balances).
    const allScheduleMonths: CcInstallmentMonthRow[] = payload.installment_history_months.map((h) => ({
      month: h.month,
      total_clp: h.installment_payments_clp,
      breakdown: [],
    }));
    const detail = buildBillingDetailByMonth(accountId, allScheduleMonths);
    return { months: payload.months, detail };
  });
}
