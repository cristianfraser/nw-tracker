import { db } from "./db.js";

/** Stored `valuations` rows (ascending) for book / month-end snapshots. */
export function loadBookValuationsAsc(
  accountId: number
): { as_of_date: string; value_clp: number }[] {
  return db
    .prepare(`SELECT as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
    .all(accountId) as { as_of_date: string; value_clp: number }[];
}
