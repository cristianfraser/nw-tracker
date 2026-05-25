import { monthKeyFromYmd } from "./calendarMonth.js";

export type CcInstallmentGastosMode = "split" | "total";

export type CcExpenseLineRole = "purchase" | "installment_cuota" | "installment_purchase_total";

export type GastosPeriodLine = {
  source: "cc" | "checking";
  expense_month: string;
  billing_month: string;
  purchase_month: string;
  line_role: CcExpenseLineRole;
  installment_flag?: number;
};

/** Calendar months used for gastos table rows and line_count. */
export function periodMonthsForGastosLine(line: GastosPeriodLine): string[] {
  if (line.line_role === "installment_purchase_total") {
    return [line.purchase_month];
  }
  if (line.line_role === "installment_cuota") {
    return [line.billing_month];
  }
  return [line.expense_month];
}

/** Whether a line appears in any month modal bucket for that calendar month. */
export function lineMatchesGastosPeriodMonth(
  line: GastosPeriodLine,
  periodMonth: string
): boolean {
  return periodMonthsForGastosLine(line).includes(periodMonth);
}

/** Month bucket for gasto del mes / chart stacks. Empty string → skip in totals. */
export function gastosSumMonthForLine(
  line: GastosPeriodLine,
  mode: CcInstallmentGastosMode = "split"
): string {
  if (line.source === "checking" || line.line_role === "purchase") {
    return line.expense_month;
  }
  if (line.line_role === "installment_purchase_total") {
    return mode === "total" ? line.purchase_month : "";
  }
  return mode === "split" ? line.billing_month : "";
}

export function purchaseMonthFromLine(
  purchaseOn: string | null,
  expenseMonth: string
): string {
  return purchaseOn ? monthKeyFromYmd(purchaseOn) : expenseMonth;
}

/** Compras table: one-shots and installment purchase totals in the purchase month. */
export function purchaseModalLines<T extends GastosPeriodLine>(
  lines: readonly T[],
  periodMonth: string
): T[] {
  return lines.filter(
    (ln) =>
      (ln.line_role === "purchase" || ln.line_role === "installment_purchase_total") &&
      ln.purchase_month === periodMonth
  );
}

/** Cuotas table: installment cuota lines billed in that month. */
export function installmentModalLines<T extends GastosPeriodLine & { billing_month: string }>(
  lines: readonly T[],
  periodMonth: string
): T[] {
  return lines.filter(
    (ln) => ln.line_role === "installment_cuota" && ln.billing_month === periodMonth
  );
}

/** Whether a line contributes to gastos_mes for the given installment counting mode. */
export function lineCountsTowardGastosSum(
  line: GastosPeriodLine & {
    amount_clp?: number;
    category_slug?: string;
    installment_flag?: number;
    nro_cuota_current?: number | null;
    nota_credito_role?: string;
  },
  mode: CcInstallmentGastosMode,
  countsTowardCategory: boolean
): boolean {
  if (!countsTowardCategory) return false;
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role === "installment_cuota") return mode === "split";
  return true;
}
