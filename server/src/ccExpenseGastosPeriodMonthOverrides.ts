import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

export type GastosPeriodMonthOverrideRow = {
  purchase_key: string;
  gastos_period_month: string;
  reason: string;
};

export function loadGastosPeriodMonthOverrides(): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT purchase_key, gastos_period_month
       FROM cc_expense_gastos_period_month_overrides`
    )
    .all() as Pick<GastosPeriodMonthOverrideRow, "purchase_key" | "gastos_period_month">[];
  const out = new Map<string, string>();
  for (const row of rows) {
    const month = String(row.gastos_period_month).trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error(
        `invalid gastos_period_month for purchase_key ${row.purchase_key}: ${row.gastos_period_month}`
      );
    }
    out.set(row.purchase_key, month);
  }
  return out;
}

export function enrichFlowLinesWithGastosPeriodMonthOverrides<
  T extends Pick<FlowCcExpenseLineRow, "purchase_key" | "gastos_period_month">,
>(lines: readonly T[], overrides?: Map<string, string>): T[] {
  const map = overrides ?? loadGastosPeriodMonthOverrides();
  if (map.size === 0) return [...lines];
  return lines.map((line) => {
    const gastos_period_month = map.get(line.purchase_key);
    if (!gastos_period_month) return line;
    return { ...line, gastos_period_month };
  });
}
