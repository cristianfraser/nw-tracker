import { monthKeyFromYmd } from "./calendarMonth.js";

export type CcInstallmentGastosMode = "split" | "total";

export type CcExpenseLineRole = "purchase" | "installment_cuota" | "installment_purchase_total";

/**
 * Per-line override of which installment mode(s) a line counts in. Default `both`.
 * `total_only` / `split_only` place a line in one mode only (facturado-financing projection);
 * `excluded` drops it from both. Keep in sync with client/src/ccExpensePeriodMonth.ts.
 */
export type CcExpenseGastosScope = "both" | "total_only" | "split_only" | "excluded";

export type GastosPeriodLine = {
  source: "cc" | "checking" | "manual";
  expense_month: string;
  gastos_period_month?: string;
  billing_month: string;
  purchase_month: string;
  line_role: CcExpenseLineRole;
  installment_flag?: number;
  gastos_scope?: CcExpenseGastosScope;
};

/** Gastos chart / table / modal calendar month for this line. */
export function gastosPeriodMonthForLine(line: GastosPeriodLine): string {
  if (line.gastos_period_month) return line.gastos_period_month;
  if (line.line_role === "installment_purchase_total") return line.purchase_month;
  if (line.line_role === "installment_cuota") return line.billing_month;
  return line.expense_month;
}

/** Calendar months used for gastos table rows and line_count. */
export function periodMonthsForGastosLine(line: GastosPeriodLine): string[] {
  return [gastosPeriodMonthForLine(line)];
}

/** Whether a line appears in any month modal bucket for that calendar month. */
export function lineMatchesGastosPeriodMonth(
  line: GastosPeriodLine,
  periodMonth: string
): boolean {
  return gastosPeriodMonthForLine(line) === periodMonth;
}

/** Month bucket for gasto del mes / chart stacks. Empty string → skip in totals. */
export function gastosSumMonthForLine(
  line: GastosPeriodLine,
  mode: CcInstallmentGastosMode = "split"
): string {
  const scope = line.gastos_scope ?? "both";
  if (scope === "excluded") return "";
  if (scope === "total_only" && mode !== "total") return "";
  if (scope === "split_only" && mode !== "split") return "";
  if (line.source === "checking" || line.line_role === "purchase") {
    return gastosPeriodMonthForLine(line);
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

/** Compras table: one-shots and installment purchase totals in the gastos period month. */
export function purchaseModalLines<T extends GastosPeriodLine>(
  lines: readonly T[],
  periodMonth: string
): T[] {
  return lines.filter(
    (ln) =>
      (ln.line_role === "purchase" || ln.line_role === "installment_purchase_total") &&
      gastosPeriodMonthForLine(ln) === periodMonth
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
  const scope = line.gastos_scope ?? "both";
  if (scope === "excluded") return false;
  if (scope === "total_only") return mode === "total";
  if (scope === "split_only") return mode === "split";
  if (line.line_role === "installment_purchase_total") return mode === "total";
  if (line.line_role === "installment_cuota") return mode === "split";
  return true;
}
