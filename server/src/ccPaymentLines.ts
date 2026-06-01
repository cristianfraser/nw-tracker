import { normCcMerchant } from "./ccDedupeKey.js";

/** CC statement / web-paste payment merchants (exact literals, not checking-cartola descriptions). */
const CC_PAYMENT_MERCHANTS = new Set(["PAGO", "MONTO CANCELADO", "ABONO"]);

export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normCcMerchant(String(merchant ?? ""));
  return m.length > 0 && CC_PAYMENT_MERCHANTS.has(m);
}

/**
 * Santander “últimos movimientos” paste: negative = charge, positive = payment.
 * DB / PDF convention: charges positive, payments negative.
 */
export function webPasteAmountClpForDb(pasteAmount: number): number {
  if (pasteAmount < 0) return Math.abs(pasteAmount);
  if (pasteAmount > 0) return -Math.abs(pasteAmount);
  return 0;
}
