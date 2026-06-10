import { db } from "./db.js";

export type MovementBoundsRow = {
  account_id: number;
  min_d: string | null;
  max_d: string | null;
};

/** Per-account MIN/MAX `occurred_on` for a set of accounts (one query). */
export function movementBoundsByAccountIds(accountIds: readonly number[]): Map<number, MovementBoundsRow> {
  const out = new Map<number, MovementBoundsRow>();
  if (!accountIds.length) return out;

  const unique = [...new Set(accountIds)];
  const ph = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, MIN(occurred_on) AS min_d, MAX(occurred_on) AS max_d
       FROM movements
       WHERE account_id IN (${ph})
       GROUP BY account_id`
    )
    .all(...unique) as MovementBoundsRow[];

  for (const r of rows) out.set(r.account_id, r);
  return out;
}
