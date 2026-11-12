import { cacheKeyCcBillingDetail, cacheKeyCcBillingDetailBase } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import {
  buildBillingDetailByMonth,
  buildFacturacionesWithoutForeignRates,
  withFacturacionForeignRates,
  type CcBillingDetailStatementRow,
  type CcFacturacionRow,
} from "./ccBillingViews.js";
import { planCount } from "./cards/purchases.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import type { CcInstallmentMonthRow } from "./cards/planTypes.js";

type CcInstallmentsDbPayload = ReturnType<typeof ccInstallmentsDbApiPayload>;

/**
 * The plan schedule by facturación month over the full history — what the detalle and the
 * facturaciones read each month's cuota a pagar from. `payload.months` is filtered to rows whose
 * pay-by has not passed; building either view from it would leave past months at 0/null: flat
 * historial bars, a wrong balance_total_clp in the detalle table, and an empty "cuota a pagar"
 * column in facturaciones.
 */
export function planScheduleMonths(payload: CcInstallmentsDbPayload): CcInstallmentMonthRow[] {
  return payload.installment_history_months.map((h) => ({
    month: h.month,
    total_clp: h.installment_payments_clp,
    breakdown: [],
  }));
}

export type CcLedgerBillingBundle = {
  /** Full ledger API payload; null when the account has no installment ledger (statements-only master). */
  payload: CcInstallmentsDbPayload | null;
  /** Statement frame only — the month frame is overlaid at response assembly (`overlayBillingDetailMonthLines`). */
  detail: CcBillingDetailStatementRow[];
  facturaciones: CcFacturacionRow[];
};

/**
 * One ledger scan + billing-detail/facturaciones build per account per cache generation.
 * The single source for `ccInstallmentsDbApiPayload` + `buildBillingDetailByMonth` +
 * `buildFacturaciones` on read paths — `creditCardInstallmentsResponse` (account page, group
 * ledger) and the CC valuations sync both consume this bundle, so the historial chart, detalle
 * table, and the valuation line can never drift apart.
 *
 * Built in two cached parts: the base (`<key>|base`: the ledger payload, the detalle and the
 * facturaciones without their dollar rates) and the bundle on top, which applies the rates. An
 * unpaid facturación shows its dollars at today's live rate, so a live tick that moves the dollar
 * drops the bundle; the base goes only if it read a moved price itself (`cacheDependencies.ts`),
 * so the rebuild re-applies the rates and nothing else.
 */
export function billingDetailCacheForAccount(accountId: number): CcLedgerBillingBundle {
  return getAggregationCached(cacheKeyCcBillingDetail(accountId), () => {
    const base = billingDetailBaseForAccount(accountId);
    return {
      payload: base.payload,
      detail: base.detail,
      facturaciones: withFacturacionForeignRates(accountId, base.facturaciones),
    } satisfies CcLedgerBillingBundle;
  });
}

function billingDetailBaseForAccount(accountId: number): CcLedgerBillingBundle {
  return getAggregationCached(cacheKeyCcBillingDetailBase(accountId), () => {
    if (planCount(accountId) === 0) {
      // Statements-only master (or empty account): billing detail from statements alone.
      return {
        payload: null,
        detail: buildBillingDetailByMonth(accountId, []),
        facturaciones: buildFacturacionesWithoutForeignRates(accountId, []),
      } satisfies CcLedgerBillingBundle;
    }
    const payload = ccInstallmentsDbApiPayload(accountId);
    const allScheduleMonths = planScheduleMonths(payload);
    return {
      payload,
      detail: buildBillingDetailByMonth(accountId, allScheduleMonths),
      facturaciones: buildFacturacionesWithoutForeignRates(accountId, allScheduleMonths),
    } satisfies CcLedgerBillingBundle;
  });
}
