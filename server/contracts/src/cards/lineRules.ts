import fs from "node:fs";
import { CC_STATEMENT_LINE_RULES_PATH } from "../ccStatementLineRules.js";
import type { CardLineKind } from "../flowKinds.js";
import { normalizeMerchantText } from "../formats/merchant.js";
import { ccStatementLineRulesSchema, type CcStatementLineRules } from "../schemas/ccStatementLineRules.js";

/**
 * Which part of a credit-card statement a line belongs to, and what kind of line it is. The rules
 * are data in `data/ccStatementLineRules.json`, read here and by `ingest/python/
 * cc_statement_line_rules.py`, so the server's import reconcile, the parse-time reconcile and every
 * source converting a line to the canonical card line (`canonicalLine.ts`) read a line the same
 * way. Both test suites assert `data/ccStatementLineSectionCases.json`.
 *
 * The file is committed and must satisfy the shared schema; a missing file or an unknown / missing
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
export const MID_PERIOD_PAYMENT_LAYOUTS: ReadonlySet<string> = new Set(RULES.mid_period_payment_layouts);
export const SECTION3_CHARGE_LAYOUTS: ReadonlySet<string> = new Set(RULES.section3_charge_layouts);
export const BCI_SECTION3_LAYOUTS: ReadonlySet<string> = new Set(RULES.bci_section3_layouts);

/** CC statement / listing payment merchants (exact literals, after `normalizeMerchantText`). */
export function isCcPaymentMerchant(merchant: string | null | undefined): boolean {
  const m = normalizeMerchantText(String(merchant ?? ""));
  return m.length > 0 && CC_PAYMENT_MERCHANTS.has(m);
}

/** «ABONO DE DIVISAS»: the payment of the USD debt (substring — some formats suffix it). */
export function isCcUsdDebtAbonoMerchant(merchant: string | null | undefined): boolean {
  return normalizeMerchantText(String(merchant ?? "")).includes(CC_USD_DEBT_ABONO_MERCHANT);
}

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

export function isUsdSection3FinancingChargeMerchant(merchant: string | null, amountUsd: number): boolean {
  if (isCcTraspasoDeudaMerchant(merchant)) return false;
  return isUsdSection3Merchant(merchant, amountUsd);
}

export type CardLineKindInput = {
  installment_flag: number | boolean;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  /** The currency of the statement the line sits on (`cc_statements.currency`). */
  statement_currency: string;
};

const nonZero = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) || v === 0 ? null : v;

/**
 * The line's own amount as its expense reads it: the dollars on a dollar statement, else the
 * pesos, else the dollars. `sign` is that amount's sign (0 when the line carries none), `usd` the
 * dollars that decide the section-3 rule (null when the line is read in pesos).
 */
function oneShotAmount(line: CardLineKindInput): { sign: number; usd: number | null } {
  const usdStatement = String(line.statement_currency ?? "").toLowerCase() === "usd";
  const usd = nonZero(line.amount_usd);
  const clp = nonZero(line.amount_clp);
  if (usdStatement && usd != null) return { sign: Math.sign(usd), usd };
  if (clp != null) return { sign: Math.sign(clp), usd: null };
  if (usd != null) return { sign: Math.sign(usd), usd };
  return { sign: 0, usd: null };
}

const isPaymentMerchant = (m: string | null) => isCcPaymentMerchant(m) || isCcUsdDebtAbonoMerchant(m);

/**
 * The one card-line classifier (docs/untangle-plan.md F10). A card statement line's kind
 * (`cc_statement_lines.kind`, migration 276; the ids are `CARD_LINE_KINDS`) is decided once, from
 * what the line itself says: its installment flag, the sign of its amount and its wording (the
 * payment, section-3 and traspaso rules of `ccStatementLineRules.json`). Every source stamps it
 * when it converts a line to the canonical card line; readers read the stored kind.
 *
 * - `installment_cuota`: a cuota a statement bills (`installment_flag = 1`).
 * - `card_payment`: a payment of the card (PAGO, MONTO CANCELADO, ABONO, ABONO DE DIVISAS).
 * - `card_debt_transfer`: a traspaso de deuda leg (dollar debt moved onto the peso side).
 * - `financing_charge`: a positive section-3 charge — intereses, comisiones, impuestos.
 * - `card_refund`: any other credit (a merchant refund, a nota de crédito).
 * - `card_purchase`: everything else.
 *
 * A positive line is tested for a section-3 charge first, as the financing stamp always read it
 * (a positive dollar ABONO DE DIVISAS is a section-3 row by the dollar rule).
 */
export function cardLineKind(line: CardLineKindInput): CardLineKind {
  const flag = line.installment_flag === true || line.installment_flag === 1;
  if (flag) return "installment_cuota";
  const { sign, usd } = oneShotAmount(line);
  const m = line.merchant;
  if (sign > 0) {
    const financing =
      usd != null && usd > 0 ? isUsdSection3FinancingChargeMerchant(m, usd) : isClpSection3FinancingChargeMerchant(m);
    if (financing) return "financing_charge";
  }
  if (isPaymentMerchant(m)) return "card_payment";
  if (isCcTraspasoDeudaMerchant(m)) return "card_debt_transfer";
  if (sign < 0) return "card_refund";
  return "card_purchase";
}
