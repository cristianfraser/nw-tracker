import type { FlowCcExpenseLineRow } from "./types";

export const NO_CUENTA_CC_EXPENSE_SLUG = "no_cuenta";

export function isInstallmentCuotaZeroLine(line: {
  installment_flag: number;
  nro_cuota_current: number | null;
}): boolean {
  return line.installment_flag === 1 && line.nro_cuota_current === 0;
}

/** Positive lines in the main «Gastos» modal section and gasto del mes total. */
export function countsTowardGastosMes(line: FlowCcExpenseLineRow): boolean {
  if (line.amount_clp <= 0) return false;
  if (line.category_slug === NO_CUENTA_CC_EXPENSE_SLUG) return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  return true;
}

export function sumLineAmountsClp(lines: readonly FlowCcExpenseLineRow[]): number {
  return lines.reduce((s, ln) => s + ln.amount_clp, 0);
}
