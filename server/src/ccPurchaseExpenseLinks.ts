import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { expenseKeyKind, installmentHKeyWithoutTotal } from "./expenseKeys.js";
import type { CcInstallmentPurchaseComputed } from "./creditCardInstallments.js";
import { planRow } from "./cards/purchases.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines } from "./flowsMortgageCarrying.js";

/**
 * A card plan's note, receipt link and display names, as its expense lines show them (the Expenses page's cached
 * lines): the lines carry the plan's `installment-h:` key — with the total, or the legacy form a
 * statement line may still carry — and every line of a plan shares the key, its note and its link.
 * A plan with no expense line gets nothing (`expense_purchase_key` absent: no note to edit).
 */
export function withPurchaseExpenseLinks(
  accountId: number,
  purchases: readonly CcInstallmentPurchaseComputed[]
): CcInstallmentPurchaseComputed[] {
  if (purchases.length === 0) return [...purchases];
  const byKey = new Map<string, FlowCcExpenseLineRow>();
  for (const l of cachedFlowsExpenseLines()) {
    if (l.source !== "cc" || l.account_id !== accountId || expenseKeyKind(l.purchase_key) !== "installment_h") continue;
    const prev = byKey.get(l.purchase_key);
    if (!prev || (!prev.payment_receipt && l.payment_receipt)) byKey.set(l.purchase_key, l);
  }
  return purchases.map((p) => {
    if (p.purchase_db_id == null) return p;
    const row = planRow(p.purchase_db_id);
    const key = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId,
      purchaseDateIso: row.purchase_date,
      cuotasTotales: row.cuotas_totales,
      totalAmountClp: row.total_amount_clp,
      merchant: row.merchant,
    });
    if (key == null) return p;
    const legacy = installmentHKeyWithoutTotal(key);
    const line = byKey.get(key) ?? (legacy ? byKey.get(legacy) : undefined);
    if (!line) return p;
    return {
      ...p,
      expense_purchase_key: line.purchase_key,
      purchase_notes: line.purchase_notes,
      ...(line.payment_receipt ? { payment_receipt: line.payment_receipt } : {}),
      ...(line.display_merchant != null ? { display_merchant: line.display_merchant } : {}),
      ...(line.merchant_processor != null ? { merchant_processor: line.merchant_processor } : {}),
      ...(line.link_label ? { link_label: line.link_label } : {}),
    };
  });
}
