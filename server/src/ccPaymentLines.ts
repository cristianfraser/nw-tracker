import { normCcMerchant } from "./ccDedupeKey.js";

/** CC statement / web-paste payment merchants (exact literals, not checking-cartola descriptions). */
const CC_PAYMENT_MERCHANTS = new Set(["PAGO", "MONTO CANCELADO", "ABONO"]);

export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normCcMerchant(String(merchant ?? ""));
  return m.length > 0 && CC_PAYMENT_MERCHANTS.has(m);
}

/**
 * Web-paste amount → DB / PDF convention: charges positive, payments negative.
 * Payment rows (PAGO, ABONO, …) are always negative; all other merchants are charges.
 */
export function webPasteAmountClpForDb(
  pasteAmount: number,
  merchant?: string | null
): number {
  const abs = Math.abs(Math.trunc(pasteAmount));
  if (abs === 0) return 0;
  if (isCcPaymentMerchant(merchant)) return -abs;
  return abs;
}
