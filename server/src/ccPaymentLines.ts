import { normCcMerchant } from "./ccDedupeKey.js";

/** CC statement / web-paste payment merchants (exact literals, not checking-cartola descriptions). */
const CC_PAYMENT_MERCHANTS = new Set(["PAGO", "MONTO CANCELADO", "ABONO"]);

export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normCcMerchant(String(merchant ?? ""));
  return m.length > 0 && CC_PAYMENT_MERCHANTS.has(m);
}

/** Santander web UI shows charges negative / payments positive — the opposite of BCI. */
function isSantanderWebPasteGroup(cardGroup?: string | null): boolean {
  return String(cardGroup ?? "").trim().toLowerCase() === "santander";
}

/**
 * Web-paste amount → DB / PDF convention: charges positive, payments / refunds negative.
 * Payment rows (PAGO, ABONO, …) are always negative. For other merchants the issuer's
 * web-UI sign convention is applied so an explicit refund / nota de crédito is preserved:
 *   - BCI / Lider: charges positive, refunds negative → keep the pasted sign.
 *   - Santander:  charges negative, refunds positive → flip the pasted sign.
 */
export function webPasteAmountClpForDb(
  pasteAmount: number,
  merchant?: string | null,
  cardGroup?: string | null
): number {
  const abs = Math.abs(Math.trunc(pasteAmount));
  if (abs === 0) return 0;
  if (isCcPaymentMerchant(merchant)) return -abs;
  if (isSantanderWebPasteGroup(cardGroup)) {
    return pasteAmount < 0 ? abs : -abs;
  }
  return pasteAmount < 0 ? -abs : abs;
}
