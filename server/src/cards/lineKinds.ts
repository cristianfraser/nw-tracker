/**
 * The one card-line classifier (docs/untangle-plan.md F10). A card statement line's kind
 * (`cc_statement_lines.kind`, migration 276; the ids are `CARD_LINE_KINDS` in
 * `nw-tracker-contracts`) is decided once, when the line is written, from what the line itself
 * says: its installment flag, the sign of its amount and its wording (the payment, section-3 and
 * traspaso rules of `ccStatementLineRules.json`). Readers read the stored kind; what depends on
 * context — the installment mode, a nota de crédito paired with the purchase it annuls, the
 * user's category, the modal section — stays with the reader.
 *
 * - `installment_cuota`: a cuota a statement bills (`installment_flag = 1`).
 * - `card_payment`: a payment of the card (PAGO, MONTO CANCELADO, ABONO, ABONO DE DIVISAS).
 * - `card_debt_transfer`: a traspaso de deuda leg (dollar debt moved onto the peso side).
 * - `financing_charge`: a positive section-3 charge — intereses, comisiones, impuestos — the cost
 *   the card's P/L counts (the peso rule, or the dollar rule when the line carries dollars).
 * - `card_refund`: any other credit (a merchant refund, a nota de crédito).
 * - `card_purchase`: everything else.
 *
 * A positive line is tested for a section-3 charge first, as the financing stamp always read it
 * (a positive dollar ABONO DE DIVISAS is a section-3 row by the dollar rule).
 */
import type { CardLineKind } from "nw-tracker-contracts";
import { isCardLineKind } from "nw-tracker-contracts";
import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant } from "../ccPaymentLines.js";
import {
  isCcTraspasoDeudaMerchant,
  isClpSection3FinancingChargeMerchant,
  isUsdSection3FinancingChargeMerchant,
} from "../ccStatementSection3.js";

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
 * pesos, else the dollars (`effectiveCcExpenseLineAmountClpWith` / `…AmountUsd`, one-shot lines).
 * `sign` is that amount's sign (0 when the line carries none), `usd` the dollars that decide the
 * section-3 rule (null when the line is read in pesos).
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

/** A stored kind, read back: anything that is not one of `CARD_LINE_KINDS` is bad stored state. */
export function requireStoredCardLineKind(value: unknown, lineId: number): CardLineKind {
  if (!isCardLineKind(value)) {
    throw new Error(`cc_statement_lines ${lineId}: kind ${JSON.stringify(value ?? null)} is not a card line kind`);
  }
  return value;
}

/** The kinds that pay or move the card's own debt — never spending. */
export function isCardDebtSettlementKind(kind: CardLineKind): boolean {
  return kind === "card_payment" || kind === "card_debt_transfer";
}
