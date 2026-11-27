import {
  MERCHANT_RULE_LAYOUTS,
  MID_PERIOD_PAYMENT_LAYOUTS,
  OPERACIONES_LAYOUTS,
  RE_USD_GARBLED_MERCHANT,
  SECTION3_LAYOUTS,
  USD_GARBLED_MERCHANT_MARKERS,
  isCcPrintedPayment,
  isClpSection3Merchant,
  isClpSection3SettlementMerchant,
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
 * `ccStatementLineRules.ts`): `skip` is a garbled international row, `ignored` a payment counted
 * nowhere (outside the payment layouts), `operaciones_credit` a peso credit outside section 3 (a
 * refund), which the bank nets into «TOTAL OPERACIONES».
 */
export type CcStatementLineSection =
  | "operaciones"
  | "operaciones_credit"
  | "cargos_abonos"
  | "mid_period_payments"
  | "ignored"
  | "skip";

/**
 * A peso line's section comes from the section the PDF printed it in, which its parser layout
 * states (`operaciones_layouts`, `section3_layouts`, `mid_period_payment_layouts`); only a layout
 * whose reader does not track the printed section (`merchant_rule_layouts`: the wide and OCR
 * readers, the statement JSON) is placed by the merchant rules. Any other layout throws, and so
 * does a line with no layout, whatever its currency: every parser row and every stored statement
 * states one (`cc_statements.layout` is NOT NULL), so a missing one is a parser bug.
 */
export function classifyCcStatementLine(line: {
  currency: "clp" | "usd"; // convention-ok: section-3 charge rules are the Chilean statements' peso and dollar lists
  merchant: string | null;
  parser_layout: string;
  amount: number;
}): CcStatementLineSection {
  if (!line.parser_layout) throw new Error(`card statement line «${line.merchant ?? ""}»: no parser layout (every parser row states one)`);
  if (line.currency === "usd") { // convention-ok: section-3 charge rules are the Chilean statements' peso and dollar lists
    if (isGarbledUsdStatementMerchant(line.merchant)) return "skip";
    if (isUsdSection3Merchant(line.merchant, line.amount)) return "cargos_abonos";
    return line.amount > 0 ? "operaciones" : "ignored";
  }
  const layout = line.parser_layout;
  const payment = isCcPrintedPayment(line.merchant, line.amount);
  if (MID_PERIOD_PAYMENT_LAYOUTS.has(layout)) return "mid_period_payments";
  // Section 3 as printed — BCI's rows included, whose forms the Santander merchant patterns miss
  // («IMPUESTO DL 3475», a merchant-named nota): the bank nets them into Monto Total Facturado;
  // its PAGO rows are payments.
  if (SECTION3_LAYOUTS.has(layout)) return payment ? "mid_period_payments" : "cargos_abonos";
  if (OPERACIONES_LAYOUTS.has(layout)) return payment ? "ignored" : "operaciones";
  if (!MERCHANT_RULE_LAYOUTS.has(layout)) {
    throw new Error(`card statement line «${line.merchant ?? ""}»: parser layout «${layout}» states no section (ccStatementLineRules.json)`);
  }
  if (payment) return "ignored";
  if (isClpSection3Merchant(line.merchant) || isClpSection3SettlementMerchant(line.merchant)) return "cargos_abonos";
  return line.amount > 0 ? "operaciones" : "operaciones_credit";
}
