/**
 * Expense-line steps for plans the bank paid off at once (`ccPlanPrepayments.ts`).
 *
 *  - The prepayment line is no spending: the plan's own purchase line carries it. It leaves the
 *    expense lines (it stays a bucket line for the facturación's bill).
 *  - The paired refund credit is the purchase's refund: it takes the plan's category and counts in
 *    «Total» only, where the plan's purchase line counts, so the purchase and its refund net to
 *    zero (in «Por cuota» the plan has no cuotas left, so neither side shows).
 */
import { allPlanPrepaymentRows } from "./ccPlanPrepaymentsRead.js";
import { merchantsMatchForCrossDedupe, planRows } from "./cards/purchases.js";

/** The fields the steps read (the expense lines carry them; a structural type keeps this a leaf of `flowsExpenses.ts`). */
type PrepaymentStepLine = {
  source: string;
  statement_line_id: number;
  account_id: number;
  line_role: string;
  purchase_on?: string | null;
  amount_clp: number;
  merchant: string | null;
  category_slug: string;
  category_unique: boolean;
};

export function dropPlanPrepaymentLines<L extends PrepaymentStepLine>(lines: readonly L[]): L[] {
  const rows = allPlanPrepaymentRows().filter((r) => r.line_id != null);
  if (rows.length === 0) return [...lines];
  const drop = new Set(rows.map((r) => `${r.account_id}|${r.line_id}`));
  return lines.filter((l) => !(l.source === "cc" && l.statement_line_id > 0 && drop.has(`${l.account_id}|${l.statement_line_id}`)));
}

export function refundPlanPrepaymentCredits<L extends PrepaymentStepLine>(lines: readonly L[]): (L | (L & { gastos_scope: "total_only" }))[] {
  const rows = allPlanPrepaymentRows().filter((r) => r.credit_line_id != null);
  if (rows.length === 0) return [...lines];
  const plans = new Map(planRows().map((p) => [p.id, p]));
  const planByCredit = new Map(rows.map((r) => [`${r.account_id}|${r.credit_line_id}`, plans.get(r.purchase_id)]));
  return lines.map((l) => {
    if (l.source !== "cc" || l.statement_line_id <= 0) return l;
    const plan = planByCredit.get(`${l.account_id}|${l.statement_line_id}`);
    if (!plan) return l;
    const totals = lines.filter(
      (t) =>
        t.source === "cc" &&
        t.line_role === "installment_purchase_total" &&
        t.account_id === plan.account_id &&
        t.purchase_on === String(plan.purchase_date).slice(0, 10) &&
        Math.round(t.amount_clp) === Math.round(plan.total_amount_clp) &&
        merchantsMatchForCrossDedupe(t.merchant, plan.merchant)
    );
    // No (or an ambiguous) purchase line to net against: the credit stays an ordinary refund.
    if (totals.length !== 1) return l;
    const total = totals[0]!;
    return { ...l, category_slug: total.category_slug, category_unique: total.category_unique, gastos_scope: "total_only" as const };
  });
}
