/**
 * The moment a movement happened, when a source states it (`movement_event_times`, migration 231).
 * The ledger stores dates only; a broker mail carries its send time, which orders same-day events
 * where order matters (a dollar withdrawal request against that day's purchases,
 * `usdCashCostLots.ts`). A stamp is written once and never overwritten.
 */
import { db } from "./db.js";

export type MovementEventTimeSource = "broker_mail";

const stmtInsert = db.prepare(
  `INSERT OR IGNORE INTO movement_event_times (movement_id, occurred_at, source, message_id)
   VALUES (?, ?, ?, ?)`
);

/** ISO UTC of a timestamp with any offset; throws on one that does not parse. */
export function isoUtc(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) throw new Error(`unparsable timestamp ${JSON.stringify(timestamp)}`);
  return new Date(ms).toISOString();
}

/** Stamps `movementId` with `occurredAt` unless it already has a stamp. True when written. */
export function recordMovementEventTime(
  movementId: number,
  occurredAt: string,
  source: MovementEventTimeSource,
  messageId: string
): boolean {
  return stmtInsert.run(movementId, isoUtc(occurredAt), source, messageId).changes > 0;
}

/** Every stamp, movement id → epoch ms. */
export function movementEventTimesMs(): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of db.prepare(`SELECT movement_id, occurred_at FROM movement_event_times`).all() as {
    movement_id: number;
    occurred_at: string;
  }[]) {
    out.set(r.movement_id, Date.parse(r.occurred_at));
  }
  return out;
}
