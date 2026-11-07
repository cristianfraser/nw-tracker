import fs from "node:fs";
import { CC_STATEMENT_LINE_RULES_PATH, ccStatementLineRulesSchema, type CcStatementLineRules } from "nw-tracker-contracts";

/**
 * Which part of a credit-card statement a parsed line belongs to. The rules are data in
 * `ccStatementLineRules.json` (in `server/contracts/data/`), read here and by `ingest/python/cc_statement_line_rules.py`, so
 * the import-time reconcile (`ccStatementImportReconcile.ts`) and the parse-time reconcile
 * (`cc_statement_reconcile.py`) sum a statement the same way. Both test suites assert
 * `server/contracts/data/ccStatementLineSectionCases.json`. The predicates built on these rules live in
 * `ccPaymentLines.ts` and `ccStatementSection3.ts`.
 *
 * The file is committed and must satisfy the shared schema (`ccStatementLineRulesSchema`, whose
 * JSON Schema the parser's tests validate it against too); a missing file or an unknown / missing
 * key throws.
 */
function loadRules(): CcStatementLineRules {
  const parsed = ccStatementLineRulesSchema.safeParse(JSON.parse(fs.readFileSync(CC_STATEMENT_LINE_RULES_PATH, "utf-8")));
  if (!parsed.success) {
    throw new Error(
      `${CC_STATEMENT_LINE_RULES_PATH}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`
    );
  }
  return parsed.data;
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
