import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant } from "nw-tracker-contracts";
import { fixedBankDescriptionPattern } from "./cards/bankDescriptionRules.js";
import { requireStoredCardLineKind } from "./cards/lineKinds.js";

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

/** A stored card line, as far as its kind goes (`cc_statement_lines.kind`, `cards/lineKinds.ts`). */
export type StoredLineKindRef = { id: number; kind: string | null };

/**
 * A stored line that pays the card: its kind is `card_payment` (PAGO, MONTO CANCELADO, ABONO and
 * the foreign side's ABONO DE DIVISAS, decided once when the line was written). A traspaso de
 * deuda leg is `card_debt_transfer`, never a payment.
 */
export function isCardPaymentLine(line: StoredLineKindRef): boolean {
  return requireStoredCardLineKind(line.kind, line.id) === "card_payment";
}

/** A stored traspaso de deuda leg (foreign debt moved onto the peso side; no cash moved). */
export function isCardDebtTransferLine(line: StoredLineKindRef): boolean {
  return requireStoredCardLineKind(line.kind, line.id) === "card_debt_transfer";
}

/**
 * A stored payment line that is the foreign side's «ABONO DE DIVISAS». The stored kind has one
 * value for every payment, so which payment it is still comes from the wording: the readers that
 * must tell the two apart (the facturado derived from a closed statement's lines, which nets a
 * divisas abono and leaves a named payment out; the divisas pairing evidence) ask here.
 */
export function isDivisasAbonoPaymentLine(line: StoredLineKindRef & { merchant: string | null }): boolean {
  return isCardPaymentLine(line) && isCcUsdDebtAbonoMerchant(line.merchant);
}

/**
 * How a line that is not stored yet (a listing row being imported) names a payment of billed debt:
 * the classifier's own payment wording, PAGO / MONTO CANCELADO / ABONO and «ABONO DE DIVISAS»
 * (substring — some formats suffix it). Stored lines are read by kind ({@link isCardPaymentLine}).
 */
export function isCcPaymentOrUsdDebtAbonoMerchant(
  merchant: string | null | undefined
): boolean {
  return isCcPaymentMerchant(merchant) || isCcUsdDebtAbonoMerchant(merchant);
}
