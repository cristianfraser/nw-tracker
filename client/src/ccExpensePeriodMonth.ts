import type { FlowCcExpenseLineRow } from "./types";

export type CcInstallmentGastosMode = "split" | "total";

/**
 * Per-line override of which installment mode(s) a line counts in. Default `both`.
 * `total_only` / `split_only` place a line in one mode only (facturado-financing projection);
 * `excluded` drops it from both. Keep in sync with server/src/ccExpensePeriodMonth.ts.
 */
export type CcExpenseGastosScope = "both" | "total_only" | "split_only" | "excluded";

/** Keep in sync with server/src/ccExpensePeriodMonth.ts */
export function gastosPeriodMonthForLine(
  line: Pick<
    FlowCcExpenseLineRow,
    "expense_month" | "billing_month" | "purchase_month" | "line_role"
  >
): string {
  if (line.line_role === "installment_purchase_total") return line.purchase_month;
  if (line.line_role === "installment_cuota") return line.billing_month;
  return line.expense_month;
}

export function periodMonthsForGastosLine(line: FlowCcExpenseLineRow): string[] {
  return [gastosPeriodMonthForLine(line)];
}

export function lineMatchesGastosPeriodMonth(
  line: FlowCcExpenseLineRow,
  periodMonth: string
): boolean {
  return gastosPeriodMonthForLine(line) === periodMonth;
}

/** Whether a line participates in the given installment mode (`gastos_scope` gate). */
export function gastosScopeAllowsMode(
  line: Pick<FlowCcExpenseLineRow, "gastos_scope">,
  mode: CcInstallmentGastosMode
): boolean {
  const scope = line.gastos_scope ?? "both";
  if (scope === "excluded") return false;
  if (scope === "total_only" && mode !== "total") return false;
  if (scope === "split_only" && mode !== "split") return false;
  return true;
}

export function gastosSumMonthForLine(
  line: FlowCcExpenseLineRow,
  mode: CcInstallmentGastosMode = "split"
): string {
  if (!gastosScopeAllowsMode(line, mode)) return "";
  if (line.source === "checking" || line.line_role === "purchase") {
    return gastosPeriodMonthForLine(line);
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
      gastosPeriodMonthForLine(ln) === periodMonth
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
