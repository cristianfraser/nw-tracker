import { invalidateLinkedCreditCardAggregationCache } from "./aggregationCache.js";
import { clearAccountCategoryMetaCache } from "./liabilitiesValuation.js";
import { db } from "./db.js";

export function updateAccountExcludeFromGroupTotals(
  accountId: number,
  raw: unknown
): { exclude_from_group_totals: 0 | 1 } | null {
  if (typeof raw !== "boolean") return null;
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(accountId) as
    | { o: number }
    | undefined;
  if (!exists) return null;

  const value = raw ? 1 : 0;
  db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(value, accountId);
  clearAccountCategoryMetaCache();
  invalidateLinkedCreditCardAggregationCache();

  return { exclude_from_group_totals: value };
}
