import { stableInstallmentHPurchaseKeyFromLedgerArgs } from "./ccExpenseCategories.js";
import { expenseKeyKind, installmentHKeyWithoutTotal } from "./expenseKeys.js";
import type { CcInstallmentPurchaseComputed } from "./cards/planTypes.js";
import { planRow } from "./cards/purchases.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines } from "./flowsMortgageCarrying.js";
import { shownNameFields, textShownName } from "./expenseShownName.js";

/**
 * A card plan's note, receipt link and shown name, as its expense lines show them (the Expenses page's cached
 * lines): the lines carry the plan's `installment-h:` key — with the total, or the legacy form a
 * statement line may still carry — and every line of a plan shares the key, its note and its link.
 * A plan with no expense line gets nothing (`expense_purchase_key` absent: no note to edit).
 */
export function withPurchaseExpenseLinks(
  accountId: number,
  purchases: readonly CcInstallmentPurchaseComputed[]
): CcInstallmentPurchaseComputed[] {
  if (purchases.length === 0) return [...purchases];
  // A plan with no expense line reads as its own label.
  const unlinked = (p: CcInstallmentPurchaseComputed): CcInstallmentPurchaseComputed => ({ ...p, name: textShownName(p.label) });
  const byKey = new Map<string, FlowCcExpenseLineRow>();
  for (const l of cachedFlowsExpenseLines()) {
    if (l.source !== "cc" || l.account_id !== accountId || expenseKeyKind(l.purchase_key) !== "installment_h") continue;
    const prev = byKey.get(l.purchase_key);
    if (!prev || (!prev.payment_receipt && l.payment_receipt)) byKey.set(l.purchase_key, l);
  }
  return purchases.map((p) => {
    if (p.purchase_db_id == null) return unlinked(p);
    const row = planRow(p.purchase_db_id);
    const key = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId,
      purchaseDateIso: row.purchase_date,
      cuotasTotales: row.cuotas_totales,
      totalAmountClp: row.total_amount_clp,
      merchant: row.merchant,
    });
    if (key == null) return unlinked(p);
    const legacy = installmentHKeyWithoutTotal(key);
    const line = byKey.get(key) ?? (legacy ? byKey.get(legacy) : undefined);
    if (!line) return unlinked(p);
    return {
      ...p,
      expense_purchase_key: line.purchase_key,
      purchase_notes: line.purchase_notes,
      ...(line.payment_receipt ? { payment_receipt: line.payment_receipt } : {}),
      ...shownNameFields(line, `plan ${p.purchase_id}`),
      ...(line.link_label ? { link_label: line.link_label } : {}),
    };
  });
}
