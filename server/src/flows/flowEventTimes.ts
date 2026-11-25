/**
 * When a flow's money moved, as its own source document states it (`flow_event_times`, migration
 * 368): written at insert by the source that knows the moment, carried through flow merges. Read
 * to order a day's «Últimos movimientos» (`latestMovementOrder.ts`). Times that come from a
 * pairing decided at read (a grocery receipt, a processor receipt, a transfer mail) are not stored
 * here; they are read beside it.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";

export type FlowEventTimeSource = "racional_movements" | "santander_account_feed";

/** Records the moment the movement's money moved, unless its flow has one. */
export function recordFlowEventTimeForMovement(
  movementId: number,
  occurredAtIso: string,
  source: FlowEventTimeSource,
  sourceRef: string,
  dbHandle: Database = db
): void {
  const instant = new Date(occurredAtIso);
  if (!Number.isFinite(instant.getTime())) throw new Error(`movement ${movementId}: event time ${occurredAtIso} is not an instant`);
  dbHandle
    .prepare(
      `INSERT OR IGNORE INTO flow_event_times (flow_id, occurred_at, source, source_ref)
       SELECT flow_id, ?, ?, ? FROM movements WHERE id = ? AND flow_id IS NOT NULL`
    )
    .run(instant.toISOString(), source, sourceRef, movementId);
}

/** Moves `from`'s event time onto `to` when `to` has none (before `from` is deleted). */
export function carryFlowEventTime(from: number, to: number, dbHandle: Database = db): void {
  if (from === to) return;
  dbHandle
    .prepare(
      `INSERT OR IGNORE INTO flow_event_times (flow_id, occurred_at, source, source_ref)
       SELECT ?, occurred_at, source, source_ref FROM flow_event_times WHERE flow_id = ?`
    )
    .run(to, from);
  dbHandle.prepare(`DELETE FROM flow_event_times WHERE flow_id = ?`).run(from);
}

/** Every flow's stated event time (epoch ms), by flow id. */
export function flowEventTimeMsByFlowId(dbHandle: Database = db): Map<number, number> {
  const rows = dbHandle.prepare(`SELECT flow_id, occurred_at FROM flow_event_times`).all() as { flow_id: number; occurred_at: string }[];
  return new Map(rows.map((r) => [r.flow_id, Date.parse(r.occurred_at)]));
}
