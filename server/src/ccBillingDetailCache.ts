import { buildBillingDetailByMonth, type CcBillingDetailMonthRow } from "./ccBillingViews.js";
import {
  ccInstallmentsDbApiPayload,
  type CcInstallmentMonthRow,
} from "./ccInstallmentLedgerDb.js";

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
  const detail = buildBillingDetailByMonth(accountId, payload.months);
  const cached = { months: payload.months, detail };
  byAccountId.set(accountId, cached);
  return cached;
}
