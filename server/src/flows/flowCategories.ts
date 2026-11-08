/**
 * «Único» categories on the flow (migration 289, docs/untangle-flow-identity.md): a row sits on a
 * flow, portion and piece with the account it was written under; `category_id` null is «Único» with
 * no category (it blocks the merchant rules). Readers still ask by (account, key); this module is
 * the one place that reads and writes the table under that shape.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { resolveExpenseKey } from "./flowKeyResolve.js";
import { flowIdForKey } from "./flowIdentity.js";
import { keyedRowsSql, keyTarget, TARGET_WHERE, targetParams } from "./flowKeyedAssignments.js";

/** The rows as `cc_expense_unique_purchases` held them: `purchase_key`, `account_id`, `category_id`. */
export const FLOW_CATEGORIES_SQL = keyedRowsSql("flow_categories", ["account_id", "category_id"]);

/** The «Único» row of the purchase a key names under `accountId` (undefined when none). */
export function getFlowCategory(
  accountId: number,
  purchaseKey: string,
  dbHandle: Database = db
): { category_id: number | null } | undefined {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return undefined;
  return dbHandle
    .prepare(`SELECT category_id FROM flow_categories WHERE ${TARGET_WHERE} AND account_id = ?`)
    .get(...targetParams(at), accountId) as { category_id: number | null } | undefined;
}

/** True when a key names a row today (or a flow answers to it). */
export function expenseKeyNamesRow(purchaseKey: string, dbHandle: Database = db): boolean {
  if (flowIdForKey(purchaseKey, dbHandle) != null) return true;
  const resolved = resolveExpenseKey(dbHandle, purchaseKey);
  if (!resolved) throw new Error(`not an expense purchase key: «${purchaseKey}»`);
  return resolved.rows.length > 0;
}

/**
 * Writes the «Único» row of the purchase a key names (the key must name a row). On a row already
 * there: `replace` sets the category, `keep` leaves it, `coalesce` sets it only when the new one is
 * not null. Returns whether a row was inserted or changed.
 */
export function putFlowCategory(
  accountId: number,
  purchaseKey: string,
  categoryId: number | null,
  onExisting: "replace" | "keep" | "coalesce",
  dbHandle: Database = db
): boolean {
  const at = keyTarget(purchaseKey, true, dbHandle);
  const set = {
    replace: `DO UPDATE SET account_id = excluded.account_id, category_id = excluded.category_id`,
    keep: `DO NOTHING`,
    coalesce: `DO UPDATE SET account_id = excluded.account_id,
      category_id = COALESCE(excluded.category_id, flow_categories.category_id)`,
  }[onExisting];
  return (
    dbHandle
      .prepare(
        `INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(flow_id, portion, piece_seq) ${set}`
      )
      .run(...targetParams(at), accountId, categoryId).changes > 0
  );
}

/** Sets the category of an existing «Único» row (nothing when there is none). */
export function updateFlowCategory(accountId: number, purchaseKey: string, categoryId: number | null, dbHandle: Database = db): void {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return;
  dbHandle
    .prepare(`UPDATE flow_categories SET category_id = ? WHERE ${TARGET_WHERE} AND account_id = ?`)
    .run(categoryId, ...targetParams(at), accountId);
}

/** Deletes the «Único» row of the purchase a key names under `accountId`; returns whether one went. */
export function deleteFlowCategory(accountId: number, purchaseKey: string, dbHandle: Database = db): boolean {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return false;
  return (
    dbHandle.prepare(`DELETE FROM flow_categories WHERE ${TARGET_WHERE} AND account_id = ?`).run(...targetParams(at), accountId)
      .changes > 0
  );
}
