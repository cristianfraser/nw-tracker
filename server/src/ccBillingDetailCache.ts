import { buildBillingDetailByMonth, type CcBillingDetailMonthRow } from "./ccBillingViews.js";
import { ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import type { CcInstallmentMonthRow } from "./creditCardInstallments.js";

type CachedBillingDetail = {
  months: CcInstallmentMonthRow[];
  detail: CcBillingDetailMonthRow[];
};

const byAccountId = new Map<number, CachedBillingDetail>();

/** Drop cached ledger + detalle por mes (call at the start of each dashboard HTTP build). */
export function clearCreditCardBillingDetailCache(): void {
  byAccountId.clear();
}

/** One `ccInstallmentsDbApiPayload` + `buildBillingDetailByMonth` per account per cache generation. */
export function billingDetailCacheForAccount(accountId: number): CachedBillingDetail {
  const hit = byAccountId.get(accountId);
  if (hit) return hit;
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
  const cached = { months: payload.months, detail };
  byAccountId.set(accountId, cached);
  return cached;
}
