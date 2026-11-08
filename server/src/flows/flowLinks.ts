/**
 * What a flow points at (`flow_links`, migrations 284–286; F20 «Links»): the plans that financed a
 * facturado, the purchase that funded a deposit, the bill a purchase paid. During the transition
 * the readers still see the rows under the key their line carries and the movement or entry they
 * name; this module is the one place that reads them back in that shape.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { expenseKeySql } from "../expenseKeys.js";
import { keyTarget, TARGET_WHERE, targetParams } from "./flowKeyedAssignments.js";

/**
 * The deposit links as `expense_deposit_links` held them (migration 285): the purchase's key, the
 * deposit movement (the movement on the counterpart flow), the figures and the source, plus
 * `link_order` (insertion order — the old table's row order; read with `ORDER BY link_order`).
 */
export const EXPENSE_DEPOSIT_LINKS_SQL = `(
  SELECT l.rowid AS link_order, l.account_id,
         ${expenseKeySql("f.legacy_key", "l.portion", "NULLIF(l.piece_seq, -1)")} AS purchase_key,
         (SELECT MIN(m.id) FROM movements m WHERE m.flow_id = l.counterpart_flow_id) AS deposit_movement_id,
         l.payment_clp, l.amortization_clp, l.depto_cuota, l.depto_occurred_on, l.link_source, l.created_at
  FROM flow_links l JOIN flows f ON f.id = l.flow_id
  WHERE l.kind = 'funded_deposit'
)`;

/**
 * The bill links as `real_estate_expense_links` held them (migration 286): the bill (an
 * `expense_entries` row with a place), the key of the purchase that paid it, the source; read with
 * `ORDER BY link_order` (insertion order).
 */
export const BILL_LINKS_SQL = `(
  SELECT l.rowid AS link_order, l.counterpart_entry_id AS expense_entry_id,
         ${expenseKeySql("f.legacy_key", "l.portion", "NULLIF(l.piece_seq, -1)")} AS purchase_key,
         l.link_source, l.created_at
  FROM flow_links l JOIN flows f ON f.id = l.flow_id
  WHERE l.kind = 'bill'
)`;

/** The refused bill pairings as `real_estate_expense_link_rejections` held them. */
export const BILL_LINK_REJECTIONS_SQL = `(
  SELECT r.counterpart_entry_id AS expense_entry_id,
         ${expenseKeySql("f.legacy_key", "r.portion", "NULLIF(r.piece_seq, -1)")} AS purchase_key, r.created_at
  FROM flow_link_rejections r JOIN flows f ON f.id = r.flow_id
  WHERE r.kind = 'bill'
)`;

/** Links the purchase a key names to a bill (the key must name a row). */
export function insertBillLink(entryId: number, purchaseKey: string, source: "auto" | "manual", dbHandle: Database = db): void {
  const at = keyTarget(purchaseKey, true, dbHandle);
  dbHandle
    .prepare(
      `INSERT INTO flow_links (flow_id, portion, piece_seq, kind, counterpart_entry_id, link_source) VALUES (?, ?, ?, 'bill', ?, ?)`
    )
    .run(...targetParams(at), entryId, source);
}

/** The key of the purchase linked to a bill, if any. */
export function billLinkPurchaseKey(entryId: number, dbHandle: Database = db): string | null {
  const row = dbHandle.prepare(`SELECT purchase_key FROM ${BILL_LINKS_SQL} WHERE expense_entry_id = ?`).get(entryId) as
    | { purchase_key: string }
    | undefined;
  return row?.purchase_key ?? null;
}

/** The bill the purchase a key names is linked to, if any. */
export function billLinkedToKey(purchaseKey: string, dbHandle: Database = db): number | null {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return null;
  const row = dbHandle
    .prepare(`SELECT counterpart_entry_id AS e FROM flow_links WHERE kind = 'bill' AND ${TARGET_WHERE}`)
    .get(...targetParams(at)) as { e: number } | undefined;
  return row?.e ?? null;
}

/** Unlinks a bill from its purchase (no refusal recorded). */
export function deleteBillLinkOfEntry(entryId: number, dbHandle: Database = db): void {
  dbHandle.prepare(`DELETE FROM flow_links WHERE kind = 'bill' AND counterpart_entry_id = ?`).run(entryId);
}

/** Drops every bill link the auto pass made; returns how many. */
export function deleteAutoBillLinks(dbHandle: Database = db): number {
  return dbHandle.prepare(`DELETE FROM flow_links WHERE kind = 'bill' AND link_source = 'auto'`).run().changes;
}

/** Records that the user refused pairing a bill with the purchase a key names. */
export function insertBillRejection(entryId: number, purchaseKey: string, dbHandle: Database = db): void {
  const at = keyTarget(purchaseKey, true, dbHandle);
  dbHandle
    .prepare(
      `INSERT OR IGNORE INTO flow_link_rejections (flow_id, portion, piece_seq, kind, counterpart_entry_id) VALUES (?, ?, ?, 'bill', ?)`
    )
    .run(...targetParams(at), entryId);
}

/**
 * Moves a bill link and its refusals from the purchase one key names onto another's (a re-import
 * re-keyed the line, the cartola row replaced the daily row). The one policy for every mover: a
 * bill pairs with one purchase and a purchase with one bill, so a target already linked to another
 * bill throws — two bills claiming one payment is a conflict a human resolves, never one dropped
 * silently; a refusal the target already carries stays. Returns whether a link moved.
 */
export function moveBillLink(fromKey: string, toKey: string, dbHandle: Database = db): boolean {
  const from = keyTarget(fromKey, false, dbHandle);
  if (!from) return false;
  const holdsAnything =
    dbHandle.prepare(`SELECT 1 FROM flow_links WHERE kind = 'bill' AND ${TARGET_WHERE}`).get(...targetParams(from)) != null ||
    dbHandle.prepare(`SELECT 1 FROM flow_link_rejections WHERE kind = 'bill' AND ${TARGET_WHERE}`).get(...targetParams(from)) !=
      null;
  if (!holdsAnything) return false;
  const to = keyTarget(toKey, true, dbHandle);
  const same = to.flowId === from.flowId && to.portion === from.portion && to.pieceSeq === from.pieceSeq;
  if (same) return false;
  dbHandle
    .prepare(`UPDATE OR IGNORE flow_link_rejections SET flow_id = ?, portion = ?, piece_seq = ? WHERE kind = 'bill' AND ${TARGET_WHERE}`)
    .run(...targetParams(to), ...targetParams(from));
  const stored = dbHandle
    .prepare(`SELECT counterpart_entry_id AS e FROM flow_links WHERE kind = 'bill' AND ${TARGET_WHERE}`)
    .get(...targetParams(from)) as { e: number } | undefined;
  if (!stored) return false;
  const current = dbHandle
    .prepare(`SELECT counterpart_entry_id AS e FROM flow_links WHERE kind = 'bill' AND ${TARGET_WHERE}`)
    .get(...targetParams(to)) as { e: number } | undefined;
  if (current) {
    throw new Error(`real-estate bills ${stored.e} and ${current.e} both claim the payment ${fromKey} → ${toKey}`);
  }
  dbHandle
    .prepare(`UPDATE flow_links SET flow_id = ?, portion = ?, piece_seq = ? WHERE kind = 'bill' AND ${TARGET_WHERE}`)
    .run(...targetParams(to), ...targetParams(from));
  return true;
}
