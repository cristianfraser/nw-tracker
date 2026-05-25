import type { FlowCcExpenseLineRow } from "./types";

export type CcInstallmentGastosMode = "split" | "total";

/** Keep in sync with server/src/ccExpensePeriodMonth.ts */
export function periodMonthsForGastosLine(line: FlowCcExpenseLineRow): string[] {
  if (line.line_role === "installment_purchase_total") {
    return [line.purchase_month];
  }
  if (line.line_role === "installment_cuota") {
    return [line.billing_month];
  }
  return [line.expense_month];
}

export function lineMatchesGastosPeriodMonth(
  line: FlowCcExpenseLineRow,
  periodMonth: string
): boolean {
  return periodMonthsForGastosLine(line).includes(periodMonth);
}

export function gastosSumMonthForLine(
  line: FlowCcExpenseLineRow,
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

export function purchaseModalLines(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string
): FlowCcExpenseLineRow[] {
  return lines.filter(
    (ln) =>
      (ln.line_role === "purchase" || ln.line_role === "installment_purchase_total") &&
      ln.purchase_month === periodMonth
  );
}

export function installmentModalLines(
  lines: readonly FlowCcExpenseLineRow[],
  periodMonth: string
): FlowCcExpenseLineRow[] {
  return lines.filter(
    (ln) => ln.line_role === "installment_cuota" && ln.billing_month === periodMonth
  );
}
