import { db } from "./db.js";

/**
 * `broker_read_coverage`: the newest read of a broker's movement list that the server applied
 * with nothing left to fix. A notification sent before it has been answered by that read.
 */

export function brokerCleanThrough(broker: "racional"): string | null {
  const row = db.prepare(`SELECT clean_through FROM broker_read_coverage WHERE broker = ?`).get(broker) as
    | { clean_through: string }
    | undefined;
  return row?.clean_through ?? null;
}

/** Moves the coverage forward to `readAt` (never back); returns the coverage after the call. */
export function recordBrokerCleanRead(broker: "racional", readAt: string, nowIso = new Date().toISOString()): string {
  const current = brokerCleanThrough(broker);
  if (current != null && Date.parse(current) >= Date.parse(readAt)) return current;
  db.prepare(
    `INSERT INTO broker_read_coverage (broker, clean_through, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(broker) DO UPDATE SET clean_through = excluded.clean_through, updated_at = excluded.updated_at`
  ).run(broker, readAt, nowIso);
  return readAt;
}
