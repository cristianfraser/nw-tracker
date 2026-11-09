import { cacheKeyDailySeries } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { getBucketDailySeries } from "./dailySeries.js";
import type { ShortHorizonAccountRef } from "./periodReturnsShortHorizon.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/**
 * A scope's full-history daily returns, and nothing else (2026-11-09).
 *
 * Every % the app shows compounds the scope's own daily `pct` over the period
 * (`periodPctDailyChain.ts`), so the home page needs the full-history daily series of every
 * account and portfolio group in both units. Those readers used to go through the cached full
 * payload (`getBucketDailySeriesCached`: every point's value, flow, delta and P/L plus a value
 * line per member account), so the home bundle alone kept ~100 MB of heap per unit on the demo
 * person — the Render Starter instance (a 256 MB V8 heap) died of «heap out of memory» 50 s
 * after boot, in the first warm step, once the US chapter made the history longer.
 *
 * Here the full series is BUILT (uncached: it reads its past part from the history tier,
 * `daily_series_past`, so a live tick still recomputes only today) and only `{as_of_date, pct}`
 * per day is kept, under its own key in the daily-series family (same invalidation rules). A
 * page's day view still builds and caches its own full payload when someone opens it.
 */
export type DailyPctPoint = { as_of_date: string; pct: number | null };

export function dailyPctPointsForScope(
  scopeKey: string,
  accounts: readonly ShortHorizonAccountRef[],
  unit: TsUnit
): readonly DailyPctPoint[] {
  const rowsKey = accounts.map((a) => a.account_id).join(",");
  return getAggregationCached(cacheKeyDailySeries(`${scopeKey}|${unit}|0|pct|${rowsKey}`), () =>
    getBucketDailySeries(accounts, { unit, days: 0 }).points.map((p) => ({ as_of_date: p.as_of_date, pct: p.pct }))
  );
}

/** A portfolio group's daily returns (`pg:<slug>`, the scope key its page uses); null for a group with no accounts. */
export function groupDailyPctPoints(groupSlug: string, unit: TsUnit): readonly DailyPctPoint[] | null {
  const rows = listAccountsForGroupTab(groupSlug).filter((r) => r.account_id > 0);
  if (!rows.length) return null;
  return dailyPctPointsForScope(`pg:${groupSlug}`, rows, unit);
}

/** One account's daily returns (`account:<id>`); excluded-from-totals accounts get theirs too. */
export function accountDailyPctPoints(
  row: { account_id: number; name: string | null; bucket_slug: string; import_key: string | null },
  unit: TsUnit
): readonly DailyPctPoint[] {
  return dailyPctPointsForScope(`account:${row.account_id}`, [{ ...row, exclude_from_group_totals: 0 }], unit);
}
