/**
 * Checking credits that are refunds of spending (migration 217): someone paying back a shared
 * expense, an additional cardholder paying back his charges. A refund is not income — the income
 * payload lists it apart (`refund_lines`) — and it is a negative gastos line in its category, so the
 * category shows what was spent net of what came back (`checkingExpenseRefundLineDrafts` in
 * `flowsExpenses.ts`). The category lives here, on the refund, and the expenses page edits it like
 * any line's.
 */
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";

export type CheckingExpenseRefund = {
  movement_id: number;
  account_id: number;
  /** ISO day the money arrived. */
  received_on: string;
  /** The credit, positive. */
  amount_clp: number;
  note: string | null;
  category_slug: string;
};

export function loadCheckingExpenseRefunds(): CheckingExpenseRefund[] {
  const rows = db
    .prepare(
      `SELECT m.id AS movement_id, m.account_id, m.occurred_on AS received_on,
              ${MOVEMENT_CLP_LEG_SQL} AS amount_clp, m.note, c.slug AS category_slug
       FROM checking_expense_refunds r
       JOIN movements m ON m.id = r.movement_id
       JOIN cc_expense_categories c ON c.id = r.category_id
       ORDER BY m.occurred_on, m.id`
    )
    .all() as CheckingExpenseRefund[];
  for (const r of rows) {
    if (r.account_id == null || !(r.amount_clp > 0)) {
      throw new Error(`refund movement ${r.movement_id} is not a single-leg checking credit (${r.amount_clp})`);
    }
    r.amount_clp = Math.round(r.amount_clp);
  }
  return rows;
}

export function loadCheckingExpenseRefundMovementIds(): Set<number> {
  const rows = db.prepare(`SELECT movement_id FROM checking_expense_refunds`).all() as { movement_id: number }[];
  return new Set(rows.map((r) => r.movement_id));
}

export function isCheckingExpenseRefund(movementId: number): boolean {
  return db.prepare(`SELECT 1 FROM checking_expense_refunds WHERE movement_id = ?`).get(movementId) != null;
}

function categoryIdFor(slug: string): number {
  const cat = getCcExpenseCategoryBySlug(slug);
  if (!cat) throw Object.assign(new Error(`unknown expense category: ${slug}`), { status: 400 });
  return cat.id;
}

/** Only a single-leg CLP credit on an account the income and gastos pages read can be a refund. */
function assertCheckingCredit(movementId: number): void {
  const row = db
    .prepare(`SELECT account_id, ${MOVEMENT_CLP_LEG_SQL} AS amount_clp FROM movements WHERE id = ?`)
    .get(movementId) as { account_id: number | null; amount_clp: number } | undefined;
  if (!row) throw Object.assign(new Error(`movement ${movementId} not found`), { status: 404 });
  if (row.account_id == null || !listMovementBalanceCashAccountIds().includes(row.account_id) || !(row.amount_clp > 0)) {
    throw Object.assign(
      new Error(`movement ${movementId} is not a checking credit (account ${row.account_id}, ${row.amount_clp} CLP)`),
      { status: 400 }
    );
  }
}

/** Marks a credit as a refund in `categorySlug` (unclassified until the expenses page sets one). */
export function markCheckingExpenseRefund(movementId: number, categorySlug = "unclassified"): void {
  assertCheckingCredit(movementId);
  db.prepare(
    `INSERT INTO checking_expense_refunds (movement_id, category_id) VALUES (?, ?)
     ON CONFLICT(movement_id) DO UPDATE SET category_id = excluded.category_id`
  ).run(movementId, categoryIdFor(categorySlug));
}

export function unmarkCheckingExpenseRefund(movementId: number): void {
  db.prepare(`DELETE FROM checking_expense_refunds WHERE movement_id = ?`).run(movementId);
}

export function setCheckingExpenseRefundCategory(movementId: number, categorySlug: string): void {
  const r = db
    .prepare(`UPDATE checking_expense_refunds SET category_id = ? WHERE movement_id = ?`)
    .run(categoryIdFor(categorySlug), movementId);
  if (r.changes !== 1) throw Object.assign(new Error(`movement ${movementId} is not a refund`), { status: 404 });
}
