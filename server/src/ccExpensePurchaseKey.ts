import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

/** Stable purchase identity (installment-h / line-pr / line-fallback), shared with categories and notes. */
export function resolvePurchaseKeyForGastosLine(
  line: Pick<
    FlowCcExpenseLineRow,
    | "source"
    | "account_id"
    | "statement_line_id"
    | "category_statement_line_id"
    | "installment_flag"
    | "purchase_on"
    | "merchant_key"
    | "nro_cuota_total"
  >
): string {
  if (line.source === "checking" && line.statement_line_id > 0) {
    return checkingGastosMovementPurchaseKey(line.statement_line_id);
  }
  if (line.statement_line_id > 0) {
    return resolveCcExpensePurchaseKey(line.statement_line_id);
  }
  const anchorId = line.category_statement_line_id;
  if (anchorId != null && anchorId > 0) {
    return resolveCcExpensePurchaseKey(anchorId);
  }
  if (
    line.installment_flag === 1 &&
    line.purchase_on &&
    line.nro_cuota_total != null &&
    line.nro_cuota_total > 0 &&
    line.merchant_key
  ) {
    return `installment-h:${line.account_id}:${line.purchase_on}:${line.nro_cuota_total}:${line.merchant_key}`;
  }
  const iso = line.purchase_on ?? "";
  return `line-fallback:${line.account_id}:${line.merchant_key}:${iso}`;
}
