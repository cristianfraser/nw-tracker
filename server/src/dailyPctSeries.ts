import { addDaysIso, isoDayNumber } from "nw-tracker-contracts";
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
 * `daily_series_past`, so a live tick still recomputes only today) and only each day's pct is
 * kept, under its own key in the daily-series family (same invalidation rules). A page's day
 * view still builds and caches its own full payload when someone opens it.
 *
 * **Kept packed** (2026-11-25): the cache holds the first day and one number per day
 * (`Float64Array`, NaN = no return) — 8 bytes a day where a `{as_of_date, pct}` object with its
 * own date string took ~80; 70 scopes × 3 units × ~4.000 days was most of the demo's heap again.
 * A reader gets the points as a list built on the spot, its date strings shared by every list
 * (`dayString`); the list lives only while its reader holds it (weakly remembered per packed
 * series, so the several reads of one build share it).
 */
export type DailyPctPoint = { as_of_date: string; pct: number | null };

/** A scope's daily returns as the cache keeps them: contiguous calendar days from `start`. */
export type PackedDailyPct = { start: string; pct: Float64Array };

/** Packs a daily series' returns. Throws unless the days are contiguous (a grid always is). */
export function packDailyPct(points: readonly DailyPctPoint[]): PackedDailyPct {
  const pct = new Float64Array(points.length);
  const start = points[0]?.as_of_date ?? "";
  const startDay = points.length > 0 ? isoDayNumber(start) : 0;
  for (const [i, p] of points.entries()) {
    if (isoDayNumber(p.as_of_date) !== startDay + i) {
      throw new Error(`daily pct series: ${p.as_of_date} is not day ${i} after ${start} (the grid must be contiguous)`);
    }
    if (p.pct !== null && !Number.isFinite(p.pct)) throw new Error(`daily pct series: ${p.as_of_date} has a pct of ${p.pct}`);
    pct[i] = p.pct ?? NaN;
  }
  return { start, pct };
}

const dayStrings = new Map<number, string>();
/** The ISO day of a day number, one string per calendar day for every list. */
function dayString(start: string, startDay: number, offset: number): string {
  const n = startDay + offset;
  let s = dayStrings.get(n);
  if (s === undefined) {
    s = addDaysIso(start, offset);
    dayStrings.set(n, s);
  }
  return s;
}

const unpacked = new WeakMap<PackedDailyPct, WeakRef<readonly DailyPctPoint[]>>();
/** The points of a packed series (shared while a reader still holds the list). */
export function unpackDailyPct(packed: PackedDailyPct): readonly DailyPctPoint[] {
  const held = unpacked.get(packed)?.deref();
  if (held) return held;
  const startDay = packed.pct.length > 0 ? isoDayNumber(packed.start) : 0;
  const points: DailyPctPoint[] = new Array(packed.pct.length);
  for (let i = 0; i < packed.pct.length; i++) {
    const v = packed.pct[i]!;
    points[i] = { as_of_date: dayString(packed.start, startDay, i), pct: Number.isNaN(v) ? null : v };
  }
  unpacked.set(packed, new WeakRef(points));
  return points;
}

export function dailyPctPointsForScope(
  scopeKey: string,
  accounts: readonly ShortHorizonAccountRef[],
  unit: TsUnit
): readonly DailyPctPoint[] {
  const rowsKey = accounts.map((a) => a.account_id).join(",");
  return unpackDailyPct(
    getAggregationCached(cacheKeyDailySeries(`${scopeKey}|${unit}|0|pct|${rowsKey}`), () =>
      packDailyPct(getBucketDailySeries(accounts, { unit, days: 0 }).points)
    )
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
