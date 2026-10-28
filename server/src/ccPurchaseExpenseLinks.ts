import {
  legacyInstallmentHPurchaseKey,
  stableInstallmentHPurchaseKeyFromLedgerArgs,
} from "./ccExpenseCategories.js";
import type { CcInstallmentPurchaseComputed } from "./creditCardInstallments.js";
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines } from "./flowsMortgageCarrying.js";

/**
 * A card plan's note and receipt link, as its expense lines show them (the Expenses page's cached
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
    if (l.source !== "cc" || l.account_id !== accountId || !l.purchase_key.startsWith("installment-h:")) continue;
    const prev = byKey.get(l.purchase_key);
    if (!prev || (!prev.payment_receipt && l.payment_receipt)) byKey.set(l.purchase_key, l);
  }
  const planRow = db.prepare(
    `SELECT purchase_date, merchant, cuotas_totales, total_amount_clp FROM cc_installment_purchases WHERE id = ?`
  );
  return purchases.map((p) => {
    if (p.purchase_db_id == null) return p;
    const row = planRow.get(p.purchase_db_id) as
      | { purchase_date: string; merchant: string | null; cuotas_totales: number; total_amount_clp: number }
      | undefined;
    if (!row) throw new Error(`cc_installment_purchases ${p.purchase_db_id} not found`);
    const key = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId,
      purchaseDateIso: row.purchase_date,
      cuotasTotales: row.cuotas_totales,
      totalAmountClp: row.total_amount_clp,
      merchant: row.merchant,
    });
    if (key == null) return p;
    const legacy = legacyInstallmentHPurchaseKey(key);
    const line = byKey.get(key) ?? (legacy ? byKey.get(legacy) : undefined);
    if (!line) return p;
    return {
      ...p,
      expense_purchase_key: line.purchase_key,
      purchase_notes: line.purchase_notes,
      ...(line.payment_receipt ? { payment_receipt: line.payment_receipt } : {}),
    };
  });
}
