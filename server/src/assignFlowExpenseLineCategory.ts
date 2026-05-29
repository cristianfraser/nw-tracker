import {
  assignCcExpenseCategoryForManualLedgerInstallmentPurchase,
  assignCcExpenseLineCategory,
  ccStatementLineBelongsToCreditCardGroup,
} from "./ccExpenseCategories.js";
import {
  assignCheckingGastosMovementCategory,
  checkingGastosMovementBelongs,
} from "./flowsCheckingGastos.js";

export type FlowExpenseLineCategorySource = "cc" | "checking";

export function assignFlowExpenseLineCategory(opts: {
  lineId: number;
  /** Required when the same numeric id exists on cuenta corriente and tarjeta. */
  source?: FlowExpenseLineCategorySource;
  unique: boolean;
  categorySlug?: string | null;
  clearCategory?: boolean;
}): {
  category_slug: string;
  unique: boolean;
  merchant_key: string;
  purchase_key: string;
} {
  if (opts.lineId < 0) {
    return assignCcExpenseCategoryForManualLedgerInstallmentPurchase({
      purchaseId: -opts.lineId,
      unique: opts.unique,
      categorySlug: opts.categorySlug ?? null,
      clearCategory: opts.clearCategory,
    });
  }

  const checking = checkingGastosMovementBelongs(opts.lineId);
  const cc = ccStatementLineBelongsToCreditCardGroup(opts.lineId);

  if (opts.source === "checking") {
    if (!checking.ok) throw new Error("checking gastos movement not found");
    return assignCheckingGastosMovementCategory({
      movementId: opts.lineId,
      unique: opts.unique,
      categorySlug: opts.categorySlug ?? null,
      clearCategory: opts.clearCategory,
    });
  }

  if (opts.source === "cc") {
    if (!cc.ok) throw new Error("statement line not in credit card group");
    return assignCcExpenseLineCategory({
      statementLineId: opts.lineId,
      unique: opts.unique,
      categorySlug: opts.categorySlug ?? null,
      clearCategory: opts.clearCategory,
    });
  }

  if (checking.ok && cc.ok) {
    throw new Error("ambiguous expense line id; pass source cc or checking");
  }
  if (checking.ok) {
    return assignCheckingGastosMovementCategory({
      movementId: opts.lineId,
      unique: opts.unique,
      categorySlug: opts.categorySlug ?? null,
      clearCategory: opts.clearCategory,
    });
  }
  if (cc.ok) {
    return assignCcExpenseLineCategory({
      statementLineId: opts.lineId,
      unique: opts.unique,
      categorySlug: opts.categorySlug ?? null,
      clearCategory: opts.clearCategory,
    });
  }

  throw new Error("expense line not found");
}
