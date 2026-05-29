import { db } from "./db.js";

function accountIdsExcludedFromGroupTotals(): ReadonlySet<number> {
  const rows = db
    .prepare(`SELECT id FROM accounts WHERE exclude_from_group_totals = 1`)
    .all() as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

export function accountCountsTowardGroupTotals(accountId: number): boolean {
  if (accountId <= 0) return true;
  return !accountIdsExcludedFromGroupTotals().has(accountId);
}
