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

/**
 * One account's daily series under the scope key its own page uses (`account:<id>`), so the
 * account page's day view and its Rentabilidad share one build. Excluded-from-totals accounts
 * still get theirs.
 */
export function resolveAccountDailySeries(
  row: { account_id: number; name: string | null; bucket_slug: string; import_key: string | null },
  unit: TsUnit,
  days: number
): BucketDailySeries {
  return getBucketDailySeriesCached(`account:${row.account_id}`, [{ ...row, exclude_from_group_totals: 0 }], {
    unit,
    days,
    includeAccounts: true,
  });
}

