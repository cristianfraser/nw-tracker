/**
 * Purchase notes on the flow (migration 287, docs/untangle-flow-identity.md): a note sits on a flow,
 * portion and piece with the account it was written under. Readers still ask by (account, key);
 * this module is the one place that reads and writes the table under that shape.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { keyedRowsSql, keyTarget, TARGET_WHERE, targetParams } from "./flowKeyedAssignments.js";

/** The notes as `cc_expense_purchase_notes` held them: `purchase_key`, `account_id`, `notes`, `updated_at`. */
export const FLOW_NOTES_SQL = keyedRowsSql("flow_notes", ["account_id", "notes", "updated_at"]);

/** The note the purchase a key names carries under `accountId` (undefined when none). */
export function getFlowNote(accountId: number, purchaseKey: string, dbHandle: Database = db): string | undefined {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return undefined;
  const row = dbHandle
    .prepare(`SELECT notes FROM flow_notes WHERE ${TARGET_WHERE} AND account_id = ?`)
    .get(...targetParams(at), accountId) as { notes: string } | undefined;
  return row?.notes;
}

/** Writes (or replaces) the note of the purchase a key names; the key must name a row. */
export function setFlowNote(accountId: number, purchaseKey: string, notes: string, dbHandle: Database = db): void {
  const at = keyTarget(purchaseKey, true, dbHandle);
  dbHandle
    .prepare(
      `INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(flow_id, portion, piece_seq) DO UPDATE SET
         account_id = excluded.account_id,
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    )
    .run(...targetParams(at), accountId, notes);
}

/** Replaces the text of an existing note (nothing when there is none). */
export function updateFlowNote(accountId: number, purchaseKey: string, notes: string, dbHandle: Database = db): void {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return;
  dbHandle
    .prepare(`UPDATE flow_notes SET notes = ?, updated_at = datetime('now') WHERE ${TARGET_WHERE} AND account_id = ?`)
    .run(notes, ...targetParams(at), accountId);
}

/** Deletes the note of the purchase a key names under `accountId`. */
export function deleteFlowNote(accountId: number, purchaseKey: string, dbHandle: Database = db): void {
  const at = keyTarget(purchaseKey, false, dbHandle);
  if (!at) return;
  dbHandle.prepare(`DELETE FROM flow_notes WHERE ${TARGET_WHERE} AND account_id = ?`).run(...targetParams(at), accountId);
}
