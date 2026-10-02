import fs from "node:fs";
import { CC_STATEMENT_LINE_RULES_PATH } from "nw-tracker-contracts";

/**
 * Which part of a credit-card statement a parsed line belongs to. The rules are data in
 * `ccStatementLineRules.json` (in `server/contracts/data/`), read here and by `ingest/python/cc_statement_line_rules.py`, so
 * the import-time reconcile (`ccStatementImportReconcile.ts`) and the parse-time reconcile
 * (`cc_statement_reconcile.py`) sum a statement the same way. Both test suites assert
 * `test/ccStatementLineSectionCases.json`. The predicates built on these rules live in
 * `ccPaymentLines.ts` and `ccStatementSection3.ts`.
 *
 * The file is committed, so a missing file or an unknown / missing key throws.
 */
type CcStatementLineRulesFile = {
  /** Exact payment merchants after trim / uppercase / whitespace collapse. */
  payment_merchants: string[];
  /** Substring naming the payment of the USD debt («ABONO DE DIVISAS»). */
  usd_debt_abono_merchant: string;
  /** Every token must appear for a traspaso de deuda (USD debt moved onto the CLP side). */
  traspaso_deuda_tokens: string[];
  /** Case-insensitive; a CLP section-3 charge (interest, fees, taxes, notas de crédito). */
  clp_section3_charge_pattern: string;
  /** Case-insensitive; a USD section-3 line. */
  usd_section3_pattern: string;
  /** Case-insensitive; a USD row made of two merged pdftotext lines. */
  usd_garbled_merchant_pattern: string;
  usd_garbled_merchant_markers: string[];
  /** CLP layouts whose rows are payments printed as lines. */
  mid_period_payment_layouts: string[];
  /** CLP layouts whose rows are section-3 charges whatever the merchant. */
  section3_charge_layouts: string[];
  /** BCI section-3 layouts: PAGO rows are payments, every other row nets into section 3. */
  bci_section3_layouts: string[];
};

const KEYS: readonly (keyof CcStatementLineRulesFile)[] = [
  "payment_merchants",
  "usd_debt_abono_merchant",
  "traspaso_deuda_tokens",
  "clp_section3_charge_pattern",
  "usd_section3_pattern",
  "usd_garbled_merchant_pattern",
  "usd_garbled_merchant_markers",
  "mid_period_payment_layouts",
  "section3_charge_layouts",
  "bci_section3_layouts",
];

const RULES_FILE = CC_STATEMENT_LINE_RULES_PATH;

function loadRules(): CcStatementLineRulesFile {
  const data = JSON.parse(fs.readFileSync(RULES_FILE, "utf-8")) as Record<string, unknown>;
  const unknown = Object.keys(data).filter((k) => !(KEYS as readonly string[]).includes(k));
  const missing = KEYS.filter((k) => !(k in data));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${RULES_FILE}: unknown keys: ${unknown.join(", ") || "-"}; missing keys: ${missing.join(", ") || "-"}`
    );
  }
  return data as CcStatementLineRulesFile;
}

const RULES = loadRules();

export const CC_PAYMENT_MERCHANTS: ReadonlySet<string> = new Set(RULES.payment_merchants);
export const CC_USD_DEBT_ABONO_MERCHANT = RULES.usd_debt_abono_merchant;
export const CC_TRASPASO_DEUDA_TOKENS: readonly string[] = RULES.traspaso_deuda_tokens;
export const RE_CLP_SECTION3_CHARGE = new RegExp(RULES.clp_section3_charge_pattern, "i");
export const RE_USD_SECTION3 = new RegExp(RULES.usd_section3_pattern, "i");
export const RE_USD_GARBLED_MERCHANT = new RegExp(RULES.usd_garbled_merchant_pattern, "i");
export const USD_GARBLED_MERCHANT_MARKERS: readonly string[] = RULES.usd_garbled_merchant_markers;
export const MID_PERIOD_PAYMENT_LAYOUTS: ReadonlySet<string> = new Set(
  RULES.mid_period_payment_layouts
);
export const SECTION3_CHARGE_LAYOUTS: ReadonlySet<string> = new Set(RULES.section3_charge_layouts);
export const BCI_SECTION3_LAYOUTS: ReadonlySet<string> = new Set(RULES.bci_section3_layouts);
