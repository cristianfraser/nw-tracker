/**
 * Checking credits that are refunds of spending (migration 217): someone paying back a shared
 * expense, an additional cardholder paying back his charges. A refund is not income — the income
 * payload lists it apart (`refund_lines`) — and it is a negative gastos line in its category, so the
 * category shows what was spent net of what came back (`checkingExpenseRefundLineDrafts` in
 * `flowsExpenses.ts`). The category lives here, on the refund, and the expenses page edits it like
 * any line's. The mark hangs off the credit's flow (`flow_refunds`, migration 280), so it stays when
 * the cartola row takes over a daily row's flow.
 *
 * A foreign checking account's credit is a refund of an expense in its currency: its own amount,
 * priced in pesos and dollars at the day's rate as its gastos lines are (`listForeignCheckingMovements`).
 */
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { listForeignCheckingAccountIds } from "./checkingCartolaLoaders.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { foreignCashCurrencyOf } from "./cashCurrency.js";
import { foreignCheckingAmountIn } from "./checkingCartolaLoaders.js";
import { HOME_CURRENCY } from "./displayUnits.js";
import { movementClpLegOrZero, type MovementAmountFields } from "./movementAmounts.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";
import { movementFlowId } from "./flows/flowIdentity.js";

export type CheckingExpenseRefund = {
  movement_id: number;
  account_id: number;
  /** ISO day the money arrived. */
  received_on: string;
  /** The credit, positive; a foreign account's at the day's stored mid. */
  amount_clp: number;
  /** A foreign checking account's credit: its dollars, positive (a dollar account's own, else at the day's mid). Null on a peso account. */
  amount_usd: number | null;
  /** A foreign checking account's credit in its own currency, positive. Null on a peso account. */
  native: { currency: string; amount: number } | null;
  note: string | null;
  category_slug: string;
};

type RefundMovementRow = MovementTransferRow &
  MovementAmountFields & { movement_id: number; account_id: number | null; received_on: string; note: string | null; category_slug: string };

/** A foreign checking credit in its account's currency (signed), else null (not on a foreign checking account). */
function foreignCredit(
  row: MovementTransferRow & { account_id: number | null },
  foreignAccountIds: ReadonlySet<number>
): { currency: string; amount: number } | null {
  if (row.account_id == null || !foreignAccountIds.has(row.account_id)) return null;
  const currency = foreignCashCurrencyOf(row.account_id);
  if (currency == null) throw new Error(`account ${row.account_id} is not a foreign cash account`);
  return { currency, amount: signedNativeDeltaForAccountMovement(row, row.account_id, currency) };
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
  const foreignAccountIds = new Set(listForeignCheckingAccountIds());
  return rows.map((r) => {
    const foreign = foreignCredit(r, foreignAccountIds);
    if (foreign != null) {
      const code = foreign.currency.toUpperCase();
      if (r.account_id == null || !(foreign.amount > 0)) {
        throw new Error(`refund movement ${r.movement_id} is not a ${code} checking credit (${foreign.amount} ${code})`);
      }
      const what = `refund movement ${r.movement_id}`;
      return {
        movement_id: r.movement_id,
        account_id: r.account_id,
        received_on: r.received_on,
        amount_clp: Math.round(foreignCheckingAmountIn(foreign.amount, foreign.currency, HOME_CURRENCY, r.received_on, what)),
        amount_usd: foreignCheckingAmountIn(foreign.amount, foreign.currency, "usd", r.received_on, what),
        native: { currency: foreign.currency, amount: foreign.amount },
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
      native: null,
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
 * a peso checking account, the account's currency on a foreign checking account.
 */
function assertCheckingCredit(movementId: number): void {
  const row = db
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, units_delta, flow_kind
       FROM movements WHERE id = ?`
    )
    .get(movementId) as (MovementTransferRow & MovementAmountFields & { account_id: number | null }) | undefined;
  if (!row) throw Object.assign(new Error(`movement ${movementId} not found`), { status: 404 });
  const foreign = foreignCredit(row, new Set(listForeignCheckingAccountIds()));
  if (foreign != null) {
    if (foreign.amount > 0) return;
    const code = foreign.currency.toUpperCase();
    throw Object.assign(
      new Error(`movement ${movementId} is not a ${code} checking credit (account ${row.account_id}, ${foreign.amount} ${code})`),
      { status: 400 }
    );
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
