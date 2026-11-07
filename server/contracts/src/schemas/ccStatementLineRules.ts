import { z } from "zod";

const strings = z.array(z.string());

/**
 * `data/ccStatementLineRules.json`: where a card statement line belongs, read by the server's
 * import reconcile (`server/src/ccStatementLineRules.ts`) and by the parser
 * (`ingest/python/cc_statement_line_rules.py`). Every key is required; an unknown key is an error.
 */
export const ccStatementLineRulesSchema = z.strictObject({
  payment_merchants: strings.describe("Exact payment merchants after trim / uppercase / whitespace collapse."),
  usd_debt_abono_merchant: z.string().describe("Substring naming the payment of the USD debt («ABONO DE DIVISAS»)."),
  traspaso_deuda_tokens: strings.describe("Every token must appear for a traspaso de deuda (USD debt moved onto the CLP side)."),
  clp_section3_charge_pattern: z.string().describe("Case-insensitive regex: a CLP section-3 charge (interest, fees, taxes, notas de crédito)."),
  usd_section3_pattern: z.string().describe("Case-insensitive regex: a USD section-3 line."),
  usd_garbled_merchant_pattern: z.string().describe("Case-insensitive regex: a USD row made of two merged pdftotext lines."),
  usd_garbled_merchant_markers: strings,
  mid_period_payment_layouts: strings.describe("CLP layouts whose rows are payments printed as lines."),
  section3_charge_layouts: strings.describe("CLP layouts whose rows are section-3 charges whatever the merchant."),
  bci_section3_layouts: strings.describe("BCI section-3 layouts: PAGO rows are payments, every other row nets into section 3."),
});

export type CcStatementLineRules = z.infer<typeof ccStatementLineRulesSchema>;
