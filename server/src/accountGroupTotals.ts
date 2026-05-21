import { db } from "./db.js";

let excludedAccountIdsCache: Set<number> | null = null;

function accountIdsExcludedFromGroupTotals(): ReadonlySet<number> {
  if (!excludedAccountIdsCache) {
    const rows = db
      .prepare(`SELECT id FROM accounts WHERE exclude_from_group_totals = 1`)
      .all() as { id: number }[];
    excludedAccountIdsCache = new Set(rows.map((r) => r.id));
  }
  return excludedAccountIdsCache;
}

export function accountCountsTowardGroupTotals(accountId: number): boolean {
  if (accountId <= 0) return true;
  return !accountIdsExcludedFromGroupTotals().has(accountId);
}
