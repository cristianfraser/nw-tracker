import {
  getBucketDailySeriesCached,
  type BucketDailySeries,
} from "./dailySeries.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/**
 * Resolve a portfolio-group's daily series the ONE canonical way, so every caller shares the
 * same cache entry. AGENTS.md warning is load-bearing: the scope key (`pg:<slug>`), the row set
 * (`listAccountsForGroupTab(slug)` filtered to real accounts) and the options must stay
 * byte-identical across the `/api/daily-series` group route and every other consumer, or the
 * cache silently stops matching and both sides rebuild. Returns null when the group has no
 * routable accounts (route → 404; other callers skip the bucket).
 */
export function resolveGroupDailySeries(
  groupSlug: string,
  unit: TsUnit,
  days: number
): BucketDailySeries | null {
  const rows = listAccountsForGroupTab(groupSlug).filter((r) => r.account_id > 0);
  if (!rows.length) return null;
  return getBucketDailySeriesCached(`pg:${groupSlug}`, rows, {
    unit,
    days,
    includeAccounts: true,
  });
}
