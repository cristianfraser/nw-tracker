/**
 * Read side of `cc_plan_prepayments` (migration 334): the plans the bank paid off at once. A leaf
 * (only `db`) for the schedule, the owed walk and the expense lines; the pairing that writes the
 * rows is `ccPlanPrepayments.ts`.
 *
 * A prepaid plan has no cuota left to bill: it leaves the cuota schedule, `cuotas por facturar` and
 * the cupo en cuotas. In the owed walk it adds its principal on the purchase day like any plan and
 * takes it off on `paid_on` ({@link planPrepaymentPayoffEvents}), where the prepayment line — a
 * normal bucket line that bills in the open facturación — puts the same debt back as facturado:
 * the prepayment moves debt from the plan remainder to the bill and is never new debt.
 */
import { db } from "./db.js";

export type PlanPrepaymentRow = {
  purchase_id: number;
  account_id: number;
  paid_on: string;
  amount_clp: number;
  /** The bucket (later statement) line of the prepayment itself; null once that line is gone. */
  line_id: number | null;
  /** The refund credit paired with the same plan; null when none was paired. */
  credit_line_id: number | null;
};

const COLUMNS = `purchase_id, account_id, paid_on, amount_clp, line_id, credit_line_id`;

export function planPrepaymentRows(accountId: number): PlanPrepaymentRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM cc_plan_prepayments WHERE account_id = ? ORDER BY paid_on, purchase_id`)
    .all(accountId) as PlanPrepaymentRow[];
}

export function allPlanPrepaymentRows(): PlanPrepaymentRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM cc_plan_prepayments ORDER BY account_id, paid_on, purchase_id`).all() as PlanPrepaymentRow[];
}

/** The plans of the card the bank paid off. */
export function prepaidPlanIds(accountId: number): Set<number> {
  return new Set(planPrepaymentRows(accountId).map((r) => r.purchase_id));
}

/** The prepayment lines of the card (never expenses: the plan's purchase carries the spending). */
export function planPrepaymentLineIds(accountId: number): Set<number> {
  const ids = new Set<number>();
  for (const r of planPrepaymentRows(accountId)) if (r.line_id != null) ids.add(r.line_id);
  return ids;
}

/** Each paired refund credit's line → the plan it refunds. */
export function planPrepaymentCreditLines(accountId: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of planPrepaymentRows(accountId)) if (r.credit_line_id != null) out.set(r.credit_line_id, r.purchase_id);
  return out;
}

/** The owed walk's event for each prepaid plan: its principal leaves the plan frame on the payoff day. */
export function planPrepaymentPayoffEvents(
  accountId: number
): { iso: string; key: string; clp: number; currency: "clp"; amount: number; statement_date: null }[] {
  return planPrepaymentRows(accountId).map((r) => ({
    iso: r.paid_on,
    key: `inst-prepay|${r.purchase_id}`,
    clp: -r.amount_clp,
    currency: "clp" as const, // convention-ok: Chilean cuota plans are pesos only
    amount: -r.amount_clp,
    statement_date: null,
  }));
}
