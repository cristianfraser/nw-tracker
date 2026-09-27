import { ccCardRegistry } from "./ccCardRegistry.js";
import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant } from "./ccPaymentLines.js";
import {
  BCI_SECTION3_LAYOUTS,
  CC_TRASPASO_DEUDA_TOKENS,
  MID_PERIOD_PAYMENT_LAYOUTS,
  RE_CLP_SECTION3_CHARGE,
  RE_USD_GARBLED_MERCHANT,
  RE_USD_SECTION3,
  SECTION3_CHARGE_LAYOUTS,
  USD_GARBLED_MERCHANT_MARKERS,
} from "./ccStatementLineRules.js";

export { RE_CLP_SECTION3_CHARGE, RE_USD_SECTION3 };

/** USD debt rolled into CLP balance — section 3 for PDF reconcile, not financing cost. */
export function isCcTraspasoDeudaMerchant(merchant: string | null | undefined): boolean {
  const m = String(merchant ?? "").trim().toUpperCase();
  return CC_TRASPASO_DEUDA_TOKENS.every((tok) => m.includes(tok));
}

export function isClpSection3Merchant(merchant: string | null): boolean {
  const m = String(merchant ?? "").trim();
  if (isCcPaymentMerchant(m)) return false;
  return RE_CLP_SECTION3_CHARGE.test(m);
}

/**
 * Section 3 of an international statement. Payments (PAGO, MONTO CANCELADO, ABONO) stay out: on
 * the legacy USD format the printed section-3 total excludes the MONTO CANCELADO rows — they sit
 * in the header's «ABONO REALIZADO» — so counting them failed the parse-time cargos check on
 * three legacy statements. «ABONO DE DIVISAS» does belong to section 3.
 */
export function isUsdSection3Merchant(merchant: string | null, amountUsd: number): boolean {
  const m = String(merchant ?? "").trim().toUpperCase();
  if (!m) return false;
  if (isCcUsdDebtAbonoMerchant(m)) return true;
  if (isCcPaymentMerchant(m)) return false;
  if (amountUsd <= 0) return true;
  return RE_USD_SECTION3.test(m);
}

export function isClpSection3FinancingChargeMerchant(merchant: string | null): boolean {
  if (isCcTraspasoDeudaMerchant(merchant)) return false;
  return isClpSection3Merchant(merchant);
}

export function isUsdSection3FinancingChargeMerchant(
  merchant: string | null,
  amountUsd: number
): boolean {
  if (isCcTraspasoDeudaMerchant(merchant)) return false;
  return isUsdSection3Merchant(merchant, amountUsd);
}

/** Merged pdftotext lines (a page counter «… DE 2» glued onto a merchant) with a wrong US$. */
export function isGarbledUsdStatementMerchant(merchant: string | null | undefined): boolean {
  const m = String(merchant ?? "").toUpperCase();
  if (RE_USD_GARBLED_MERCHANT.test(m)) return true;
  if (USD_GARBLED_MERCHANT_MARKERS.some((marker) => m.includes(marker))) return true;
  return ccCardRegistry().multicard_marker_tokens.some((t) => m.includes(t.toUpperCase()));
}

/**
 * Section a non-installment statement line sums into (both reconcilers, see
 * `ccStatementLineRules.ts`): `skip` is a garbled international row, `ignored` a line counted
 * nowhere (a payment or refund outside the payment layouts).
 */
export type CcStatementLineSection =
  | "operaciones"
  | "cargos_abonos"
  | "mid_period_payments"
  | "ignored"
  | "skip";

export function classifyCcStatementLine(line: {
  currency: "clp" | "usd";
  merchant: string | null;
  parser_layout: string;
  amount: number;
}): CcStatementLineSection {
  if (line.currency === "usd") {
    if (isGarbledUsdStatementMerchant(line.merchant)) return "skip";
    if (isUsdSection3Merchant(line.merchant, line.amount)) return "cargos_abonos";
    return line.amount > 0 ? "operaciones" : "ignored";
  }
  const layout = line.parser_layout;
  if (MID_PERIOD_PAYMENT_LAYOUTS.has(layout)) return "mid_period_payments";
  if (SECTION3_CHARGE_LAYOUTS.has(layout)) return "cargos_abonos";
  // BCI section-3 rows carry their own parser layout; the merchant patterns are Santander-shaped
  // and miss BCI's forms — «IMPUESTO DL 3475» (singular) and merchant-named abonos like the
  // 2026-06 «GLASS LIDER.CL» -3x.xxx nota. The bank nets these into Monto Total Facturado
  // (2026-06: 2.xxx.xxx − 3x.xxx + 811 = 2.xxx.xxx exactly), so they land in cargos_abonos;
  // PAGOs never do.
  if (BCI_SECTION3_LAYOUTS.has(layout)) {
    return isCcPaymentMerchant(line.merchant) ? "mid_period_payments" : "cargos_abonos";
  }
  if (isClpSection3Merchant(line.merchant)) return "cargos_abonos";
  return line.amount > 0 ? "operaciones" : "ignored";
}
