/**
 * Assignment tables named by an expense key during the transition (docs/untangle-flow-identity.md,
 * F9 step 3): each row sits on a flow (`flow_id`), a portion of it (`gastos` | `deposit`, a checking
 * movement's deposit-paired part) and a piece (`piece_seq`, -1 for the whole flow). Readers see the
 * rows under the key their line carries ({@link keyedRowsSql}); writers name the row by key
 * ({@link keyTarget}); the re-key movers move rows between keys ({@link moveKeyedRows}) until
 * adoption on arrival (step 4) removes them.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { expenseKeySql, type CheckingPortion } from "../expenseKeys.js";
import { ensureFlowForKey, expenseKeyParts, flowIdForKey } from "./flowIdentity.js";

export type KeyTarget = { flowId: number; portion: CheckingPortion; pieceSeq: number };

/** `piece_seq` of a row on the whole flow. */
export const WHOLE_FLOW_PIECE = -1;

/**
 * Where a key's row sits. `create`: the flow is found or stamped ({@link ensureFlowForKey}, throws
 * when the key names no row); otherwise null when no flow carries the key.
 */
export function keyTarget(key: string, create: true, dbHandle?: Database): KeyTarget;
export function keyTarget(key: string, create: false, dbHandle?: Database): KeyTarget | null;
export function keyTarget(key: string, create: boolean, dbHandle: Database = db): KeyTarget | null {
  const parts = expenseKeyParts(key);
  if (!parts) throw new Error(`not an expense purchase key: «${key}»`);
  const flowId = create ? ensureFlowForKey(key, dbHandle) : flowIdForKey(key, dbHandle);
  if (flowId == null) return null;
  return { flowId, portion: parts.portion, pieceSeq: parts.pieceSeq ?? WHOLE_FLOW_PIECE };
}

/** `WHERE` fragment naming one target (3 parameters: flow, portion, piece). */
export const TARGET_WHERE = `flow_id = ? AND portion = ? AND piece_seq = ?`;

export function targetParams(t: KeyTarget): [number, CheckingPortion, number] {
  return [t.flowId, t.portion, t.pieceSeq];
}

/**
 * A keyed table as the key-named rows its readers used to select: `purchase_key` plus `columns`
 * (`<alias>.<column>` per entry), joined on the flow.
 */
export function keyedRowsSql(table: string, columns: readonly string[]): string {
  const key = expenseKeySql("f.legacy_key", "a.portion", `NULLIF(a.piece_seq, ${WHOLE_FLOW_PIECE})`);
  const cols = columns.map((c) => `a.${c}`).join(", ");
  return `(SELECT ${key} AS purchase_key${cols ? `, ${cols}` : ""} FROM ${table} a JOIN flows f ON f.id = a.flow_id)`;
}

/**
 * Moves the row a key names onto another key (the re-key movers). `conflict`: `keep-target` leaves
 * the target's own row (and drops the moved one), `replace-target` overwrites it, `throw` refuses.
 * Returns whether a row moved.
 */
export function moveKeyedRows(
  table: string,
  fromKey: string,
  toKey: string,
  conflict: "keep-target" | "replace-target" | "throw",
  dbHandle: Database = db
): boolean {
  const from = keyTarget(fromKey, false, dbHandle);
  if (!from) return false;
  const has = dbHandle.prepare(`SELECT 1 FROM ${table} WHERE ${TARGET_WHERE}`).get(...targetParams(from)) != null;
  if (!has) return false;
  const to = keyTarget(toKey, true, dbHandle);
  if (to.flowId === from.flowId && to.portion === from.portion && to.pieceSeq === from.pieceSeq) return false;
  const exists = dbHandle.prepare(`SELECT 1 FROM ${table} WHERE ${TARGET_WHERE}`).get(...targetParams(to)) != null;
  if (exists) {
    if (conflict === "throw") throw new Error(`${table}: «${fromKey}» and «${toKey}» both carry a row`);
    if (conflict === "keep-target") {
      dbHandle.prepare(`DELETE FROM ${table} WHERE ${TARGET_WHERE}`).run(...targetParams(from));
      return false;
    }
    dbHandle.prepare(`DELETE FROM ${table} WHERE ${TARGET_WHERE}`).run(...targetParams(to));
  }
  dbHandle
    .prepare(`UPDATE ${table} SET flow_id = ?, portion = ?, piece_seq = ? WHERE ${TARGET_WHERE}`)
    .run(...targetParams(to), ...targetParams(from));
  return true;
}

/** Deletes the row a key names (nothing when no flow carries the key). */
export function deleteKeyedRow(table: string, key: string, dbHandle: Database = db): void {
  const at = keyTarget(key, false, dbHandle);
  if (at) dbHandle.prepare(`DELETE FROM ${table} WHERE ${TARGET_WHERE}`).run(...targetParams(at));
}
