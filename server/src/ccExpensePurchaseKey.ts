import {
  resolveCcExpensePurchaseKey,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
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
    | "installment_total_clp"
  > & { checking_purchase_portion?: "deposit" }
): string {
  if (line.source === "manual" && line.statement_line_id > 0) {
    return `manual:${line.statement_line_id}`;
  }
  if (line.source === "checking" && line.statement_line_id > 0) {
    return checkingGastosMovementPurchaseKey(
      line.statement_line_id,
      line.checking_purchase_portion === "deposit" ? "deposit" : "gastos"
    );
  }
  if (line.source === "checking" && line.statement_line_id < 0) {
    // checking_gap_deposit_mirrors row id, encoded as a negative statement_line_id by
    // flowsCheckingGapDepositMirrors.ts. Real checking lines always carry a positive
    // movements.id, so this convention is unambiguous.
    return `synthetic-checking-gap-mirror:${-line.statement_line_id}`;
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
    const hKey = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId: line.account_id,
      purchaseDateIso: line.purchase_on,
      cuotasTotales: line.nro_cuota_total,
      totalAmountClp: line.installment_total_clp,
      merchant: line.merchant_key,
    });
    if (hKey) return hKey;
  }
  const iso = line.purchase_on ?? "";
  return `line-fallback:${line.account_id}:${line.merchant_key}:${iso}`;
}
