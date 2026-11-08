import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant } from "nw-tracker-contracts";
import { ccIssuerForWebPasteCardGroup } from "./ccIssuers.js";
import { fixedBankDescriptionPattern } from "./cards/bankDescriptionRules.js";

/**
 * How a checking account's description names a card payment (`bankDescriptionRules.json`
 * `cc_payment`): MONTO CANCELADO, PAGO … TARJETA, a traspaso to the card or the overdraft line, a
 * divisas purchase, a CMR online payment. The card side's own names are {@link isCcPaymentMerchant}.
 */
export const CC_PAYMENT_DESC_RE = fixedBankDescriptionPattern("cc_payment");

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
  return isCcPaymentMerchant(merchant) || isCcUsdDebtAbonoMerchant(merchant);
}

/**
 * Web-paste amount → DB / PDF convention: charges positive, payments / refunds negative.
 * Payment rows (PAGO, ABONO, …) are always negative. For other merchants the issuer's web-UI sign
 * (`CC_ISSUERS[…].web_paste.sign`, found by the card group the line is pasted under) is applied so
 * an explicit refund / nota de crédito is preserved: charges shown positive keep the pasted sign,
 * charges shown negative (Santander) are flipped.
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

/**
 * The inverse of {@link webPasteAmountClpForDb} / {@link webPasteAmountUsdForDb} for a
 * debt-positive amount (charge +, payment / credit −): the amount as the issuer's web UI shows
 * it, so an ingested listing line reaches the web-paste import exactly as a paste of the same row.
 */
export function webPasteAmountFromDebtPositive(amount: number, cardGroup?: string | null): number {
  return ccIssuerForWebPasteCardGroup(cardGroup).web_paste.sign === "charges_negative" ? -amount : amount;
}

function webPasteSignedAmount(
  pasteAmount: number,
  merchant?: string | null,
  cardGroup?: string | null
): number {
  const abs = Math.abs(pasteAmount);
  if (abs === 0) return 0;
  if (isCcPaymentMerchant(merchant)) return -abs;
  if (ccIssuerForWebPasteCardGroup(cardGroup).web_paste.sign === "charges_negative") {
    return pasteAmount < 0 ? abs : -abs;
  }
  return pasteAmount < 0 ? -abs : abs;
}
