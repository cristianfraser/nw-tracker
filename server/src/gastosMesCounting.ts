/**
 * Whether an expense line counts toward «gasto del mes» in an installment mode, and the sign it is
 * read by. A leaf: the gastos views, the expense-line pipeline and the additional-card summary all
 * read this one rule.
 */
import type { Money } from "nw-tracker-contracts/dto/flows";
import { isCcExpenseTotalsExcludedSlug, isInstallmentCuotaZeroLine } from "./ccExpenseCategories.js";
import type { CcInstallmentGastosMode } from "./ccExpensePeriodMonth.js";
import type { FlowCcExpenseLineRow } from "./expenseLineTypes.js";

/**
 * What a line's sign is read from: its money (`amount`, set by the «line money» step) on a
 * finished line, the builder's pesos on a builder line (the checking lines read before the
 * pipeline, `loadFinalizedCheckingGastosLinesReadOnly`). The sign is the same in every unit.
 */
export type SignedExpenseLine = { amount?: Money; amount_clp?: number };

export function expenseLineSignedValue(line: SignedExpenseLine): number {
  if (line.amount) return line.amount.value;
  if (line.amount_clp != null) return line.amount_clp;
  throw new Error("expense line without an amount");
}

/** The fields {@link countsTowardGastosMes} reads (the checking read-only lines carry them too). */
export type GastosMesLine = SignedExpenseLine &
  Pick<
    FlowCcExpenseLineRow,
    | "nota_credito_role"
    | "checking_refund"
    | "card_refund"
    | "category_slug"
    | "installment_flag"
    | "nro_cuota_current"
    | "gastos_scope"
    | "line_role"
  >;

/**
 * A negative line that is spending coming back — a checking credit marked as a refund
 * (`checking_refund`) or a card credit no purchase annuls (`card_refund`: a merchant refund, a nota
 * de crédito without its purchase): it counts, negatively, in its category.
 */
export function isGastosRefundLine(line: Pick<GastosMesLine, "checking_refund" | "card_refund">): boolean {
  return line.checking_refund === true || line.card_refund === true;
}

/** Positive lines, and refunds, that count toward gasto del mes in the mode. */
export function countsTowardGastosMes(line: GastosMesLine, mode: CcInstallmentGastosMode): boolean {
  if (line.nota_credito_role === "annulled_purchase" || line.nota_credito_role === "matched_nota") {
    return false;
  }
  if (expenseLineSignedValue(line) <= 0 && !isGastosRefundLine(line)) return false;
  if (isCcExpenseTotalsExcludedSlug(line.category_slug)) return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  const scope = line.gastos_scope ?? "both";
  if (scope === "excluded") return false;
  if (scope === "total_only") return mode === "total";
  if (scope === "split_only") return mode === "split";
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role === "installment_cuota") return mode === "split";
  return true;
}
