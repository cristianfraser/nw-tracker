import type { ExpenseMonthModalSection, FlowCcExpenseLineRow } from "./types";

/** «Por cuota» (split) or «Total» — the Expenses page's installment mode. */
export type CcInstallmentGastosMode = "split" | "total";

/**
 * A line's shape as the server sent it (`expenseLineShapes.ts`, the read pipeline's last step).
 * Every line the client receives carries it; a missing one is payload drift and throws.
 */
function requireShape<K extends "period_month" | "month_modal_sections" | "counts_toward_gastos">(
  line: FlowCcExpenseLineRow,
  field: K
): NonNullable<FlowCcExpenseLineRow[K]> {
  const v = line[field];
  if (v == null) {
    throw new Error(`expense line ${line.source}:${line.statement_line_id} has no ${field} (server line shapes)`);
  }
  return v as NonNullable<FlowCcExpenseLineRow[K]>;
}

/** The month the line is shown in. */
export function linePeriodMonth(line: FlowCcExpenseLineRow): string {
  return requireShape(line, "period_month");
}

/** Whether the month modal lists the line under `section` in `mode`. */
export function lineInModalSection(
  line: FlowCcExpenseLineRow,
  mode: CcInstallmentGastosMode,
  section: ExpenseMonthModalSection
): boolean {
  return requireShape(line, "month_modal_sections")[mode].includes(section);
}

/** Whether the line counts toward gasto del mes in `mode`. */
export function lineCountsTowardGastos(line: FlowCcExpenseLineRow, mode: CcInstallmentGastosMode): boolean {
  return requireShape(line, "counts_toward_gastos")[mode];
}
