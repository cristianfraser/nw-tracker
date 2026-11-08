import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant } from "nw-tracker-contracts";
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
