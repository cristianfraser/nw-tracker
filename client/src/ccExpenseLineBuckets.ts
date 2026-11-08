import type { FlowCcExpenseLineRow, FlowCcExpenseLineSource } from "./types";

export const NO_CUENTA_CC_EXPENSE_SLUG = "no_cuenta";

/** Internal transfers to investments — excluded from gastos totals and chart stacks. */
export const DEPOSITS_CC_EXPENSE_SLUG = "deposits";

/** Mortgage principal on real-estate deposit matches — chart stack only. */
export const REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG = "real_estate_amortization";

/** Carrying cost for linked mortgage payments. */
export const BILLS_CC_EXPENSE_SLUG = "bills";

/** Corriente ↔ vista checking auto-matches — excluded from gastos totals and chart stacks. */
export const CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG = "checking_internal_transfer";

export const CC_EXPENSE_TOTALS_EXCLUDED_SLUGS = new Set([
  NO_CUENTA_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
]);

export function isCcExpenseTotalsExcludedSlug(categorySlug: string): boolean {
  return CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(categorySlug);
}

/** Real statement line id to use for category / unique PATCH. */
export function expenseLineCategoryTargetId(line: FlowCcExpenseLineRow): number {
  return line.category_statement_line_id ?? line.statement_line_id;
}

function sameInstallmentPurchaseGroup(
  a: FlowCcExpenseLineRow,
  b: FlowCcExpenseLineRow
): boolean {
  // Distinct purchase_keys ⇒ distinct purchases, even when account/date/cuotas/merchant coincide
  // (e.g. two same-day EXPRESS PLAZA 3-cuotas buys of different amounts). Without this, toggling
  // Único / a category on one optimistically flips the other.
  if (a.purchase_key && b.purchase_key && a.purchase_key !== b.purchase_key) return false;
  return (
    a.account_id === b.account_id &&
    a.purchase_on != null &&
    a.purchase_on === b.purchase_on &&
    a.nro_cuota_total != null &&
    a.nro_cuota_total === b.nro_cuota_total &&
    a.merchant_key === b.merchant_key &&
    (a.line_role === "installment_cuota" || a.line_role === "installment_purchase_total") &&
    (b.line_role === "installment_cuota" || b.line_role === "installment_purchase_total")
  );
}

export function expenseLineMatchesCategoryPatch(
  ln: FlowCcExpenseLineRow,
  targetLineId: number,
  anchorLine?: FlowCcExpenseLineRow,
  source?: FlowCcExpenseLineSource
): boolean {
  if (source != null && ln.source !== source) return false;
  if (expenseLineCategoryTargetId(ln) === targetLineId) return true;
  if (ln.statement_line_id === targetLineId) return true;
  if (ln.category_statement_line_id === targetLineId) return true;
  if (anchorLine && sameInstallmentPurchaseGroup(ln, anchorLine)) return true;
  return false;
}

/** All gastos lines for one purchase (cuotas, consolidated total, checking split). */
export function expenseLineMatchesCategoryPurchaseKey(
  ln: FlowCcExpenseLineRow,
  accountId: number,
  purchaseKey: string
): boolean {
  return ln.account_id === accountId && ln.purchase_key === purchaseKey;
}

export function expenseLineMatchesPurchaseNotePatch(
  ln: FlowCcExpenseLineRow,
  accountId: number,
  purchaseKey: string
): boolean {
  return ln.account_id === accountId && ln.purchase_key === purchaseKey;
}

export function expenseLineMatchesPurchaseBigGroupPatch(
  ln: FlowCcExpenseLineRow,
  purchaseKey: string
): boolean {
  // A big group belongs to the expense: its purchase key names it whichever account paid it.
  return ln.purchase_key === purchaseKey;
}

export function sumLineAmountsClp(lines: readonly FlowCcExpenseLineRow[]): number {
  return lines.reduce((s, ln) => s + ln.amount_clp, 0);
}
