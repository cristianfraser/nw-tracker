import type { CcInstallmentGastosMode } from "./ccExpensePeriodMonth";
import type { FlowCcExpenseLineRow, FlowCcExpenseLineSource } from "./types";

export const NO_CUENTA_CC_EXPENSE_SLUG = "no_cuenta";

/** Internal transfers to investments — excluded from gastos totals and chart stacks. */
export const DEPOSITS_CC_EXPENSE_SLUG = "deposits";

/** Corriente ↔ vista checking auto-matches — excluded from gastos totals and chart stacks. */
export const CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG = "checking_internal_transfer";

export const CC_EXPENSE_TOTALS_EXCLUDED_SLUGS = new Set([
  NO_CUENTA_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
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
  accountId: number,
  purchaseKey: string
): boolean {
  return ln.account_id === accountId && ln.purchase_key === purchaseKey;
}

export function isBigGroupExcludedFromChart(
  line: FlowCcExpenseLineRow,
  excluded: ReadonlySet<string>
): boolean {
  return line.big_group_slug != null && excluded.has(line.big_group_slug);
}

export function isInstallmentCuotaZeroLine(line: {
  installment_flag: number;
  nro_cuota_current: number | null;
}): boolean {
  return line.installment_flag === 1 && line.nro_cuota_current === 0;
}

/** Positive lines that count toward gasto del mes for the active installment mode. */
export function countsTowardGastosMes(
  line: FlowCcExpenseLineRow,
  mode: CcInstallmentGastosMode = "split"
): boolean {
  if (line.nota_credito_role === "annulled_purchase" || line.nota_credito_role === "matched_nota") {
    return false;
  }
  // Small fee adjustments affect gastos totals only (see aggregateGastosFromLines), not compras/cuotas UI.
  if (line.nota_credito_role === "unmatched_nota") return false;
  if (line.amount_clp <= 0) return false;
  if (isCcExpenseTotalsExcludedSlug(line.category_slug)) return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role === "installment_cuota") return mode === "split";
  return true;
}

/** Compras modal table: purchase-month lines that belong in the gastos compras list. */
export function countsTowardComprasModal(
  line: FlowCcExpenseLineRow,
  mode: CcInstallmentGastosMode = "split"
): boolean {
  if (isCcExpenseTotalsExcludedSlug(line.category_slug)) return false;
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role !== "purchase") return false;
  return countsTowardGastosMes(line, mode);
}

/** Negative lines shown in the «Abonos» modal section (excludes NOTA DE CREDITO handling). */
export function countsTowardAbonosMes(line: FlowCcExpenseLineRow): boolean {
  if (line.amount_clp >= 0) return false;
  if (line.nota_credito_role === "matched_nota" || line.nota_credito_role === "unmatched_nota") {
    return false;
  }
  return true;
}

/** Matched NOTA / annulled purchase pairs shown under «Excluidos». */
export function isNotaCreditoExcludedLine(line: FlowCcExpenseLineRow): boolean {
  return (
    line.nota_credito_role === "annulled_purchase" || line.nota_credito_role === "matched_nota"
  );
}

export function sumLineAmountsClp(lines: readonly FlowCcExpenseLineRow[]): number {
  return lines.reduce((s, ln) => s + ln.amount_clp, 0);
}
