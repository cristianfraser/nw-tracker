import { db } from "./db.js";

let excludedAccountIdsCache: Set<number> | null = null;

/** Bust after migrations or account updates that touch `exclude_from_group_totals`. */
export function clearAccountGroupTotalsCache(): void {
  excludedAccountIdsCache = null;
}

/** Account IDs omitted from class totals, dashboard buckets, and overview NW/cash lines. */
export function accountIdsExcludedFromGroupTotals(): ReadonlySet<number> {
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
