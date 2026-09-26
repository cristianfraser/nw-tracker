import type { FlowCcExpenseLineRow } from "../../types";

export type FinancingCandidate = {
  key: string; // `${account_id}|${purchase_key}`
  account_id: number;
  purchase_key: string;
  merchant: string;
  /** Identical purchases sharing the key (same-statement twins) — one financing target. */
  purchase_count: number;
  /** Combined principal of those purchases. */
  amount_clp: number;
  purchase_month: string;
  origin_label: string;
};

/**
 * Installment purchases a facturado can be financed with, one row per purchase key, newest
 * purchase month first. A financing link stores `{ account_id, purchase_key }` and covers every
 * plan carrying that key, so identical same-statement twins (one «Total» line each) are a single
 * target, shown with their count and combined principal.
 */
export function financingCandidatesFromLines(
  lines: readonly FlowCcExpenseLineRow[]
): FinancingCandidate[] {
  const byKey = new Map<string, FinancingCandidate>();
  for (const ln of lines) {
    if (ln.line_role !== "installment_purchase_total") continue;
    const key = `${ln.account_id}|${ln.purchase_key}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.purchase_count += 1;
      existing.amount_clp += ln.amount_clp;
      continue;
    }
    byKey.set(key, {
      key,
      account_id: ln.account_id,
      purchase_key: ln.purchase_key,
      merchant: ln.merchant ?? "",
      purchase_count: 1,
      amount_clp: ln.amount_clp,
      purchase_month: ln.purchase_month,
      origin_label: ln.origin_label,
    });
  }
  return [...byKey.values()].sort((a, b) => b.purchase_month.localeCompare(a.purchase_month));
}
