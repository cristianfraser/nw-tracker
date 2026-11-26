/**
 * The categories a hand-entered plan still finds only under its pre-amount key.
 *
 * A plan's `installment-h:` key gained the plan's total as a segment; a category written before
 * that sits on the flow of the identity-only form (`installmentHKeyWithoutTotal`). When the
 * statement takes over a manual plan, `resolveCategoryIdForManualPurchase`
 * (`src/ccManualInstallmentStatementReconcile.ts`) still falls back to that key. This planner
 * finds each manual plan whose own key carries no category while its legacy key does, so the
 * category can be moved onto the current key once and the fallback deleted.
 *
 * Outcomes per manual plan with a categorized legacy key:
 * - `rekey`: the current key has no «Único» row → the legacy row moves onto it;
 * - `same`: the current key already carries the same category → nothing to do (the fallback
 *   never fires);
 * - `ambiguous` (reported, never written): the current key carries another category or an
 *   «Único» row with none (the fallback picks the legacy one today), or another plan of the
 *   account shares the identity with a different total (the legacy key could be either's).
 */
import type { Database } from "better-sqlite3";
import { stableInstallmentHPurchaseKeyFromLedgerArgs, normalizeCcExpenseMerchantKey } from "../../src/ccExpenseCategories.js";
import { installmentHKeyWithoutTotal } from "../../src/expenseKeys.js";
import { getFlowCategory } from "../../src/flows/flowCategories.js";
import { moveKeyedRows } from "../../src/flows/flowKeyedAssignments.js";

export type LegacyInstallmentKeyRekeyItem = {
  plan_id: number;
  account_id: number;
  merchant: string | null;
  purchase_date: string;
  current_key: string;
  legacy_key: string;
  legacy_category_id: number;
  current_category_id: number | null | undefined;
  outcome: "rekey" | "same" | "ambiguous";
  reason?: string;
};

type ManualPlanRow = {
  id: number;
  account_id: number;
  purchase_date: string;
  cuotas_totales: number;
  total_amount_clp: number;
  merchant: string | null;
};

export function planLegacyInstallmentKeyRekey(dbHandle: Database): LegacyInstallmentKeyRekeyItem[] {
  const plans = dbHandle
    .prepare(
      `SELECT id, account_id, purchase_date, cuotas_totales, total_amount_clp, merchant
       FROM cc_installment_purchases WHERE source = 'manual' ORDER BY id`
    )
    .all() as ManualPlanRow[];
  const sameIdentity = dbHandle.prepare(
    `SELECT id, total_amount_clp, merchant FROM cc_installment_purchases
     WHERE account_id = ? AND date(purchase_date) = date(?) AND cuotas_totales = ?`
  );
  const out: LegacyInstallmentKeyRekeyItem[] = [];
  for (const p of plans) {
    const current = stableInstallmentHPurchaseKeyFromLedgerArgs({
      accountId: p.account_id,
      purchaseDateIso: p.purchase_date,
      cuotasTotales: p.cuotas_totales,
      totalAmountClp: p.total_amount_clp,
      merchant: p.merchant,
    });
    if (current == null) continue;
    const legacy = installmentHKeyWithoutTotal(current);
    if (legacy == null) continue;
    const legacyCat = getFlowCategory(p.account_id, legacy, dbHandle);
    if (legacyCat?.category_id == null) continue;
    const currentCat = getFlowCategory(p.account_id, current, dbHandle);
    const base = {
      plan_id: p.id,
      account_id: p.account_id,
      merchant: p.merchant,
      purchase_date: p.purchase_date,
      current_key: current,
      legacy_key: legacy,
      legacy_category_id: legacyCat.category_id,
      current_category_id: currentCat?.category_id,
    };
    const merchantKey = normalizeCcExpenseMerchantKey(p.merchant);
    const otherTotals = new Set(
      (sameIdentity.all(p.account_id, p.purchase_date, p.cuotas_totales) as ManualPlanRow[])
        .filter((r) => r.id !== p.id && normalizeCcExpenseMerchantKey(r.merchant) === merchantKey)
        .map((r) => Math.round(r.total_amount_clp))
        .filter((t) => t !== Math.round(p.total_amount_clp))
    );
    if (otherTotals.size > 0) {
      out.push({
        ...base,
        outcome: "ambiguous",
        reason: `another plan of the account shares the identity with total ${[...otherTotals].join(", ")}`,
      });
    } else if (currentCat == null) {
      out.push({ ...base, outcome: "rekey" });
    } else if (currentCat.category_id === legacyCat.category_id) {
      out.push({ ...base, outcome: "same" });
    } else {
      out.push({
        ...base,
        outcome: "ambiguous",
        reason:
          currentCat.category_id == null
            ? "the current key has an «Único» row with no category (today the legacy category wins on reconcile)"
            : `the current key carries category ${currentCat.category_id}`,
      });
    }
  }
  return out;
}

/** Moves each `rekey` item's legacy «Único» row onto its current key. Returns how many moved. */
export function applyLegacyInstallmentKeyRekey(
  dbHandle: Database,
  items: readonly LegacyInstallmentKeyRekeyItem[]
): number {
  let moved = 0;
  for (const it of items) {
    if (it.outcome !== "rekey") continue;
    if (moveKeyedRows("flow_categories", it.legacy_key, it.current_key, "throw", dbHandle)) moved += 1;
  }
  return moved;
}
