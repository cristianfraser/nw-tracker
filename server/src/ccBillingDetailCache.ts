import {
  cacheKeyCcBillingDetail,
  getAggregationCached,
} from "./aggregationCache.js";
import {
  buildBillingDetailByMonth,
  buildFacturaciones,
  type CcBillingDetailMonthRow,
  type CcFacturacionRow,
} from "./ccBillingViews.js";
import { ccInstallmentLedgerRowCount, ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import type { CcInstallmentMonthRow } from "./creditCardInstallments.js";

type CcInstallmentsDbPayload = ReturnType<typeof ccInstallmentsDbApiPayload>;

export type CcLedgerBillingBundle = {
  /** Full ledger API payload; null when the account has no installment ledger (statements-only master). */
  payload: CcInstallmentsDbPayload | null;
  detail: CcBillingDetailMonthRow[];
  facturaciones: CcFacturacionRow[];
};

/**
 * One ledger scan + billing-detail/facturaciones build per account per cache generation.
 * The single source for `ccInstallmentsDbApiPayload` + `buildBillingDetailByMonth` +
 * `buildFacturaciones` on read paths — `creditCardInstallmentsResponse` (account page, group
 * ledger) and the CC valuations sync both consume this bundle, so the historial chart, detalle
 * table, and the valuation line can never drift apart.
 */
export function billingDetailCacheForAccount(accountId: number): CcLedgerBillingBundle {
  return getAggregationCached(cacheKeyCcBillingDetail(accountId), () => {
    if (ccInstallmentLedgerRowCount(accountId) === 0) {
      // Statements-only master (or empty account): billing detail from statements alone.
      return {
        payload: null,
        detail: buildBillingDetailByMonth(accountId, []),
        facturaciones: buildFacturaciones(accountId, []),
      } satisfies CcLedgerBillingBundle;
    }
    const payload = ccInstallmentsDbApiPayload(accountId);
    // Build billing detail and facturaciones with the full history schedule so
    // cuota_a_pagar_next_mes_clp / cuota_a_pagar_clp are non-zero for past billing months too.
    // payload.months is filtered to >= nowYm; passing it to either builder would leave those
    // lookups returning 0/null for past months — flat historial bars, wrong balance_total_clp
    // in the detalle table, and an empty "cuota a pagar" column in facturaciones.
    const allScheduleMonths: CcInstallmentMonthRow[] = payload.installment_history_months.map(
      (h) => ({ month: h.month, total_clp: h.installment_payments_clp, breakdown: [] })
    );
    return {
      payload,
      detail: buildBillingDetailByMonth(accountId, allScheduleMonths),
      facturaciones: buildFacturaciones(accountId, allScheduleMonths),
    } satisfies CcLedgerBillingBundle;
  });
}

