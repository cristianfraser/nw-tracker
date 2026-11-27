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
  clp_section3_settlement_pattern: z
    .string()
    .describe("Case-insensitive regex: a CLP section-3 line that is no financing cost (a cuota plan the bank prepaid, billed whole)."),
  usd_section3_pattern: z.string().describe("Case-insensitive regex: a USD section-3 line."),
  usd_garbled_merchant_pattern: z.string().describe("Case-insensitive regex: a USD row made of two merged pdftotext lines."),
  usd_garbled_merchant_markers: strings,
  printed_payment_prefix_pattern: z
    .string()
    .describe("Case-insensitive regex: a payment line opens like this and prints negative (or is an exact payment merchant)."),
  operaciones_layouts: strings.describe("CLP layouts read from the printed operaciones (section 1): every row sums there, whatever the merchant."),
  section3_layouts: strings.describe("CLP layouts read from the printed section 3: a payment is a mid-period payment, every other row nets into section 3."),
  mid_period_payment_layouts: strings.describe("CLP layouts whose rows are payments printed as lines."),
  merchant_rule_layouts: strings.describe(
    "Layouts whose reader does not track the printed section (rows of several sections share them): the merchant rules place each row. Any other layout is an error."
  ),
});

export type CcStatementLineRules = z.infer<typeof ccStatementLineRulesSchema>;
