import { normCcMerchant } from "./ccDedupeKey.js";

/** CC statement / web-paste payment merchants (exact literals, not checking-cartola descriptions). */
const CC_PAYMENT_MERCHANTS = new Set(["PAGO", "MONTO CANCELADO", "ABONO"]);

export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normCcMerchant(String(merchant ?? ""));
  return m.length > 0 && CC_PAYMENT_MERCHANTS.has(m);
}

/**
 * The previous facturación's payment date printed in a statement header
 * (`cc_statements.monto_pagado_anterior_date`, migration 166). The import stores it as ISO or
 * not at all, so every reader of header payments — the owed walk, the cuota retirement and the
 * payment-mirror evidence — takes it through here: anything else is bad stored state and
 * throws rather than being re-parsed, skipped or passed on raw.
 */
export function requireHeaderPagoIso(statementDate: string, raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`cc_statements ${statementDate}: invalid monto_pagado_anterior_date ${raw}`);
  }
  return raw;
}

/**
 * Payment-of-billed-debt lines including the USD side's «ABONO DE DIVISAS» (substring match —
 * some formats suffix it). A traspaso-linked abono is debt reclassification, not a payment, but
 * links only exist on PDF statement lines — open-cycle (web-paste / feed) lines never carry
 * them, so a merchant-only test is safe in open-month scope. Deliberately NOT folded into
 * CC_PAYMENT_MERCHANTS: that exact set also drives web-paste signing, the import reconcile and
 * checking predicates, and widening it would change the derived facturado of legacy header-less
 * USD statements (which feeds their month-end valuation anchors).
 */
export function isCcPaymentOrUsdDebtAbonoMerchant(
  merchant: string | null | undefined
): boolean {
  if (isCcPaymentMerchant(merchant)) return true;
  return normCcMerchant(String(merchant ?? "")).includes("ABONO DE DIVISAS");
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
  return webPasteSignedAmount(Math.trunc(pasteAmount), merchant, cardGroup);
}

/** Same sign convention as {@link webPasteAmountClpForDb} but keeps USD decimals (no truncation). */
export function webPasteAmountUsdForDb(
  pasteAmount: number,
  merchant?: string | null,
  cardGroup?: string | null
): number {
  return webPasteSignedAmount(pasteAmount, merchant, cardGroup);
}

function webPasteSignedAmount(
  pasteAmount: number,
  merchant?: string | null,
  cardGroup?: string | null
): number {
  const abs = Math.abs(pasteAmount);
  if (abs === 0) return 0;
  if (isCcPaymentMerchant(merchant)) return -abs;
  if (isSantanderWebPasteGroup(cardGroup)) {
    return pasteAmount < 0 ? abs : -abs;
  }
  return pasteAmount < 0 ? -abs : abs;
}
