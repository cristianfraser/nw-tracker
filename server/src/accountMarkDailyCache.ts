import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { getAggregationCached, setAggregationCached } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";

/**
 * Per-account CLP mark series on the Chile calendar-day grid, cached so the daily views stop
 * re-walking evidence for every account × every day. Marks dominate a daily build (full
 * history ≈ 3.7k days × ~31 accounts), and the three daily consumers — the bucket series
 * (`dailySeries.ts`), the dashboard bucket totals (`portfolioGroupValueAtDate.ts`) and the
 * liabilities leg of the overview payload (`dashboardOverviewDaily.ts`) — ask for the same
 * marks over overlapping windows.
 *
 * **Only days strictly before Chile today are cached.** Today's mark comes from the live
 * stack (fresh quotes, intraday fx) and would go stale within the 5-minute poll, so it is
 * always computed. That split is what lets a live-quote tick keep the whole cache: no
 * historical mark reads `live_market_quotes` (see `invalidateDailyAggregates`).
 *
 * Entries live in the aggregation cache under `daily.marks|<accountId>|<bucketSlug>`, so they
 * clear at Chile day rollover and when another process commits a write, exactly like every
 * other cached aggregation. The series **extends** in both directions as wider windows are
 * requested (a 90-day view pays 90 days; a later "total" view pays only the missing prefix),
 * which is why this module writes through {@link setAggregationCached}.
 *
 * Values are `value_clp` only — `accountMarkClpAtYmd` also returns the evidence date
 * (`as_of_date`, which can predate the requested day), and callers that need it must keep
 * calling the mark function directly.
 */

export type MarkSeriesAccountRef = {
  account_id: number;
  bucket_slug: string;
  import_key?: string | null;
  name?: string | null;
};

type CachedMarkSeries = {
  /** First cached day (inclusive). */
  start_ymd: string;
  /** Last cached day (inclusive); always < Chile today. */
  end_ymd: string;
  /** CLP marks indexed from `start_ymd`; null where the account has no valid mark. */
  values: (number | null)[];
};

const MS_PER_DAY = 86_400_000;

/** Whole days from `fromYmd` to `toYmd` (negative when `toYmd` is earlier). */
function dayOffset(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error(`accountMarkDailyCache: invalid date range ${fromYmd}..${toYmd}`);
  }
  return Math.round((to - from) / MS_PER_DAY);
}

function markClpAt(account: MarkSeriesAccountRef, ymd: string): number | null {
  const mark = accountMarkClpAtYmd(account.account_id, ymd, account.bucket_slug, {
    import_key: account.import_key ?? null,
    name: account.name ?? null,
  });
  const clp = mark?.value_clp;
  return clp != null && Number.isFinite(clp) ? clp : null;
}

/** Marks for the inclusive day range, computed one by one (no cache involvement). */
function buildRange(
  account: MarkSeriesAccountRef,
  startYmd: string,
  endYmd: string
): (number | null)[] {
  const count = dayOffset(startYmd, endYmd) + 1;
  const out = new Array<number | null>(count);
  for (let i = 0; i < count; i++) {
    out[i] = markClpAt(account, i === 0 ? startYmd : chileCalendarAddDays(startYmd, i));
  }
  return out;
}

/**
 * A series whose `values` length disagrees with its date range would silently shift every
 * mark by whole days, so it is checked rather than trusted on each extend.
 */
function assertSeriesAligned(series: CachedMarkSeries, account: MarkSeriesAccountRef): void {
  const expected = dayOffset(series.start_ymd, series.end_ymd) + 1;
  if (series.values.length !== expected) {
    throw new Error(
      `accountMarkDailyCache: misaligned series for account ${account.account_id} ` +
        `(${series.start_ymd}..${series.end_ymd} = ${expected} days, got ${series.values.length})`
    );
  }
}

function cacheKey(account: MarkSeriesAccountRef): string {
  // Bucket slug is part of the identity: it selects the valuation branch inside
  // `accountMarkClpAtYmd`, and the same account can reach this module from group tabs that
  // label it differently. The trailing delimiter keeps account 16 out of 1617's keys.
  return `daily.marks|${account.account_id}|${account.bucket_slug}`;
}

/**
 * Cached series covering at least `[startYmd, endYmd]`, extending an existing entry rather
 * than rebuilding it. Both ends are assumed to be before Chile today (the caller splits).
 */
function cachedSeriesCovering(
  account: MarkSeriesAccountRef,
  startYmd: string,
  endYmd: string
): CachedMarkSeries {
  const key = cacheKey(account);
  const cached = getAggregationCached<CachedMarkSeries>(key, () => ({
    start_ymd: startYmd,
    end_ymd: endYmd,
    values: buildRange(account, startYmd, endYmd),
  }));
  assertSeriesAligned(cached, account);
  const needsPrefix = startYmd < cached.start_ymd;
  const needsSuffix = endYmd > cached.end_ymd;
  if (!needsPrefix && !needsSuffix) return cached;

  const prefix = needsPrefix
    ? buildRange(account, startYmd, chileCalendarAddDays(cached.start_ymd, -1))
    : [];
  const suffix = needsSuffix
    ? buildRange(account, chileCalendarAddDays(cached.end_ymd, 1), endYmd)
    : [];
  const extended: CachedMarkSeries = {
    start_ymd: needsPrefix ? startYmd : cached.start_ymd,
    end_ymd: needsSuffix ? endYmd : cached.end_ymd,
    values: [...prefix, ...cached.values, ...suffix],
  };
  assertSeriesAligned(extended, account);
  setAggregationCached(key, extended);
  return extended;
}

/**
 * CLP marks for `account` at each day of `grid`, index-aligned with it.
 *
 * `grid` must be a contiguous ascending run of Chile calendar days — the shape every daily
 * consumer builds. Days before Chile today are served from (and folded into) the cached
 * series; today and anything later are computed live on every call.
 */
export function accountMarkClpSeriesOnGrid(
  account: MarkSeriesAccountRef,
  grid: readonly string[]
): (number | null)[] {
  if (grid.length === 0) return [];
  const first = grid[0]!;
  const last = grid[grid.length - 1]!;
  // O(1) contiguity check: any gap, duplicate or out-of-order day breaks this identity.
  if (dayOffset(first, last) !== grid.length - 1) {
    throw new Error(
      `accountMarkClpSeriesOnGrid: grid must be contiguous ascending calendar days (${first}..${last}, ${grid.length} days)`
    );
  }

  const today = chileCalendarTodayYmd();
  const out = new Array<number | null>(grid.length);
  const cacheableEnd = last < today ? last : chileCalendarAddDays(today, -1);
  if (first <= cacheableEnd) {
    const series = cachedSeriesCovering(account, first, cacheableEnd);
    const base = dayOffset(series.start_ymd, first);
    const cachedCount = dayOffset(first, cacheableEnd) + 1;
    for (let i = 0; i < cachedCount; i++) out[i] = series.values[base + i] ?? null;
  }
  for (let i = Math.max(0, dayOffset(first, cacheableEnd) + 1); i < grid.length; i++) {
    out[i] = markClpAt(account, grid[i]!);
  }
  return out;
}

/**
 * @internal Test hook: the uncached equivalent of {@link accountMarkClpSeriesOnGrid}, so the
 * identity test can compare cached output against a direct per-day mark walk.
 */
export function accountMarkClpSeriesOnGridUncached(
  account: MarkSeriesAccountRef,
  grid: readonly string[]
): (number | null)[] {
  return grid.map((ymd) => markClpAt(account, ymd));
}
