/**
 * Checking credits that are refunds of spending (migration 217): someone paying back a shared
 * expense, an additional cardholder paying back his charges. A refund is not income — the income
 * payload lists it apart (`refund_lines`) — and it is a negative gastos line in its category, so the
 * category shows what was spent net of what came back (`checkingExpenseRefundLineDrafts` in
 * `flowsExpenses.ts`). The category lives here, on the refund, and the expenses page edits it like
 * any line's. The mark hangs off the credit's flow (`flow_refunds`, migration 280), so it stays when
 * the cartola row takes over a daily row's flow.
 *
 * A dollar checking account's credit is a refund of a dollar expense: its dollars, priced in pesos
 * at the day's rate as its gastos lines are (`listDollarCheckingMovements`).
 */
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { listDollarCheckingAccountIds } from "./checkingCartolaLoaders.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { movementClpLegOrZero, type MovementAmountFields } from "./movementAmounts.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";
import { movementFlowId } from "./flows/flowIdentity.js";

export type CheckingExpenseRefund = {
  movement_id: number;
  account_id: number;
  /** ISO day the money arrived. */
  received_on: string;
  /** The credit, positive; a dollar account's at the day's `fx_daily` rate. */
  amount_clp: number;
  /** A dollar checking account's credit: its dollars, positive. Null on a peso account. */
  amount_usd: number | null;
  note: string | null;
  category_slug: string;
};

type RefundMovementRow = MovementTransferRow &
  MovementAmountFields & { movement_id: number; account_id: number | null; received_on: string; note: string | null; category_slug: string };

/** A dollar checking credit's dollars (positive), else null; a listed row that moves no dollars throws. */
function dollarCreditUsd(row: MovementTransferRow & { account_id: number | null }, dollarAccountIds: ReadonlySet<number>): number | null {
  if (row.account_id == null || !dollarAccountIds.has(row.account_id)) return null;
  return signedNativeDeltaForAccountMovement(row, row.account_id, "usd");
}

export function loadCheckingExpenseRefunds(): CheckingExpenseRefund[] {
  const rows = db
    .prepare(
      `SELECT m.id AS movement_id, m.account_id, m.from_account_id, m.to_account_id, m.occurred_on AS received_on,
              m.amount, m.currency, m.counter_amount, m.counter_currency, m.units_delta, m.flow_kind,
              m.note, c.slug AS category_slug
       FROM flow_refunds r
       JOIN movements m ON m.flow_id = r.flow_id
       JOIN cc_expense_categories c ON c.id = r.category_id
       ORDER BY m.occurred_on, m.id`
    )
    .all() as RefundMovementRow[];
  const dollarAccountIds = new Set(listDollarCheckingAccountIds());
  return rows.map((r) => {
    const usd = dollarCreditUsd(r, dollarAccountIds);
    if (usd != null) {
      if (r.account_id == null || !(usd > 0)) throw new Error(`refund movement ${r.movement_id} is not a dollar checking credit (${usd} USD)`);
      const fx = fxRowOnOrBefore(r.received_on);
      if (!fx || !(fx.clp_per_usd > 0)) throw new Error(`refund movement ${r.movement_id}: no fx on or before ${r.received_on}`);
      return {
        movement_id: r.movement_id,
        account_id: r.account_id,
        received_on: r.received_on,
        amount_clp: Math.round(usd * fx.clp_per_usd),
        amount_usd: usd,
        note: r.note,
        category_slug: r.category_slug,
      };
    }
    const clp = movementClpLegOrZero(r);
    if (r.account_id == null || !(clp > 0)) {
      throw new Error(`refund movement ${r.movement_id} is not a single-leg checking credit (${clp})`);
    }
    return {
      movement_id: r.movement_id,
      account_id: r.account_id,
      received_on: r.received_on,
      amount_clp: Math.round(clp),
      amount_usd: null,
      note: r.note,
      category_slug: r.category_slug,
    };
  });
}

export function isCheckingExpenseRefund(movementId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM flow_refunds r JOIN movements m ON m.flow_id = r.flow_id WHERE m.id = ?`).get(movementId) != null
  );
}

function categoryIdFor(slug: string): number {
  const cat = getCcExpenseCategoryBySlug(slug);
  if (!cat) throw Object.assign(new Error(`unknown expense category: ${slug}`), { status: 400 });
  return cat.id;
}

/**
 * Only a single-leg credit on an account the income and gastos pages read can be a refund: pesos on
 * a peso checking account, dollars on a dollar checking account.
 */
function assertCheckingCredit(movementId: number): void {
  const row = db
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, units_delta, flow_kind
       FROM movements WHERE id = ?`
    )
    .get(movementId) as (MovementTransferRow & MovementAmountFields & { account_id: number | null }) | undefined;
  if (!row) throw Object.assign(new Error(`movement ${movementId} not found`), { status: 404 });
  const usd = dollarCreditUsd(row, new Set(listDollarCheckingAccountIds()));
  if (usd != null) {
    if (usd > 0) return;
    throw Object.assign(new Error(`movement ${movementId} is not a dollar checking credit (account ${row.account_id}, ${usd} USD)`), { status: 400 });
  }
  const clp = movementClpLegOrZero(row);
  if (row.account_id == null || !listMovementBalanceCashAccountIds().includes(row.account_id) || !(clp > 0)) {
    throw Object.assign(
      new Error(`movement ${movementId} is not a checking credit (account ${row.account_id}, ${clp} CLP)`),
      { status: 400 }
    );
  }
}

/** Marks a credit as a refund in `categorySlug` (unclassified until the expenses page sets one). */
export function markCheckingExpenseRefund(movementId: number, categorySlug = "unclassified"): void {
  assertCheckingCredit(movementId);
  db.prepare(
    `INSERT INTO flow_refunds (flow_id, category_id) VALUES (?, ?)
     ON CONFLICT(flow_id) DO UPDATE SET category_id = excluded.category_id`
  ).run(movementFlowId(movementId), categoryIdFor(categorySlug));
}

export function unmarkCheckingExpenseRefund(movementId: number): void {
  db.prepare(`DELETE FROM flow_refunds WHERE flow_id = ?`).run(movementFlowId(movementId));
}

export function setCheckingExpenseRefundCategory(movementId: number, categorySlug: string): void {
  const r = db
    .prepare(`UPDATE flow_refunds SET category_id = ? WHERE flow_id = ?`)
    .run(categoryIdFor(categorySlug), movementFlowId(movementId));
  if (r.changes !== 1) throw Object.assign(new Error(`movement ${movementId} is not a refund`), { status: 404 });
}
