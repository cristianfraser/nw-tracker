import {
  cacheKeyCcBillingDetail,
  getAggregationCached,
  invalidateCcBillingDetail,
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
 * Drop every cached ledger + detalle por mes entry. Entries live in the aggregation cache
 * (fresh per Chile day + external `data_version` bumps); same-connection CC writes invalidate
 * per account via `invalidateCcBillingDetail` — this full clear is for tests/tools only.
 */
export function clearCreditCardBillingDetailCache(): void {
  invalidateCcBillingDetail();
}

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

/** Ledger payload from the cached bundle; throws when the account has no installment ledger. */
export function requireLedgerPayloadForAccount(accountId: number): CcInstallmentsDbPayload {
  const { payload } = billingDetailCacheForAccount(accountId);
  if (payload == null) {
    throw new Error(`account ${accountId}: no installment ledger — caller must guard on ledger row count`);
  }
  return payload;
}
