import { db } from "./db.js";

export type MovementBoundsRow = {
  account_id: number;
  min_d: string | null;
  max_d: string | null;
};

/** Per-account MIN/MAX `occurred_on` (legacy rows + transfer legs). */
export function movementBoundsByAccountIds(accountIds: readonly number[]): Map<number, MovementBoundsRow> {
  const out = new Map<number, MovementBoundsRow>();
  if (!accountIds.length) return out;

  for (const accountId of [...new Set(accountIds)]) {
    const row = db
      .prepare(
        `SELECT MIN(occurred_on) AS min_d, MAX(occurred_on) AS max_d
         FROM movements
         WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
      )
      .get(accountId, accountId, accountId) as { min_d: string | null; max_d: string | null };
    out.set(accountId, { account_id: accountId, min_d: row.min_d, max_d: row.max_d });
  }
  return out;
}
