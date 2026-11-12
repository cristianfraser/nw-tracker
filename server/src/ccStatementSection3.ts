import {
  BCI_SECTION3_LAYOUTS,
  MID_PERIOD_PAYMENT_LAYOUTS,
  RE_USD_GARBLED_MERCHANT,
  SECTION3_CHARGE_LAYOUTS,
  USD_GARBLED_MERCHANT_MARKERS,
  isCcPaymentMerchant,
  isClpSection3Merchant,
  isUsdSection3Merchant,
} from "nw-tracker-contracts";
import { ccCardRegistry } from "./ccCardRegistry.js";

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
  currency: "clp" | "usd"; // convention-ok: section-3 charge rules are the Chilean statements' peso and dollar lists
  merchant: string | null;
  parser_layout: string;
  amount: number;
}): CcStatementLineSection {
  if (line.currency === "usd") { // convention-ok: section-3 charge rules are the Chilean statements' peso and dollar lists
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
