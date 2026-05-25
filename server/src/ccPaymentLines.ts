import { normCcMerchant } from "./ccDedupeKey.js";

/** Statement lines that reduce the balance (payments), not purchases. */
const PAYMENT_MERCHANT_RE = /^(PAGO|MONTO CANCELADO|ABONO\b)/i;

export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normCcMerchant(String(merchant ?? ""));
  if (!m) return false;
  return PAYMENT_MERCHANT_RE.test(m);
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
