import { getAggregationCached } from "./aggregationCache.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { chileCalendarDaysListEndingAt, totalRangeDays } from "./dailySeries.js";
import { clpToUsdForBalanceAt, ufClpByDateRange, ufRowOnOrBefore } from "./fxRates.js";
import { buildDashboardBucketDailySeriesClp } from "./portfolioGroupValueAtDate.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * All-time high of the net-worth line, as the dashboard's Patrimonio neto chart marks it —
 * ONE PEAK PER GRAIN, each taken over the series that grain actually plots, so the marker
 * always sits on the line and its label speaks that grain's date:
 *
 * - `day`: the FULL-HISTORY daily walk — every calendar day from `portfolioStartYmd` through
 *   Chile today (today live), the series the Diario overview plots.
 * - `month` / `year`: the latest-dated overview point of each calendar month / year — exactly
 *   the rows the Mensual grid (`densifyRecordsByCalendarPeriod`) and the Anual rollup
 *   (`rollupTimeseriesBlockYearEnd`) keep. The daily peak usually falls between month-ends,
 *   so the three can differ in both date and value (2026-06-02 2xx,xx M vs June's 2xx,xx M).
 *
 * Computed per display unit (each day converts at its own fx/UF), because the CLP and USD
 * peaks can be different days. Ties resolve to the EARLIEST day, the day the record was set.
 */
export type NetWorthAthDto = { as_of_date: string; value: number };

export type NetWorthAthByPeriod = {
  /** Peak of the full-history daily walk (the Diario grid). */
  day: NetWorthAthDto | null;
  /** Peak of the rows the Mensual grid plots: the latest-dated overview point of each calendar month. */
  month: NetWorthAthDto | null;
  /** Peak of the rows the Anual grid plots: the latest-dated overview point of each calendar year. */
  year: NetWorthAthDto | null;
};

/** The overview block's net-worth line. */
const OVERVIEW_NET_WORTH_KEY = "total_nw";

/** Earliest day carrying the maximum finite value; null when nothing is finite. Order-independent. */
export function pickAllTimeHigh(
  points: readonly { as_of_date: string; value: number | null }[]
): NetWorthAthDto | null {
  let best: NetWorthAthDto | null = null;
  for (const p of points) {
    const v = p.value;
    if (v == null || !Number.isFinite(v)) continue;
    if (best == null || v > best.value || (v === best.value && p.as_of_date < best.as_of_date)) {
      best = { as_of_date: p.as_of_date, value: v };
    }
  }
  return best;
}

/**
 * Peak over the rows a month/year grid plots: per calendar bucket the LATEST-dated row wins
 * (a month-end over that month's earlier snapshot; today over the current month's month-end
 * is impossible, today IS the latest), then the earliest maximum among those rows. The row's
 * own date is reported, so the marker lands on a plotted point.
 */
export function pickAllTimeHighOnCalendarGrid(
  points: readonly Record<string, string | number | null>[],
  valueKey: string,
  grain: "month" | "year"
): NetWorthAthDto | null {
  const width = grain === "month" ? 7 : 4;
  const latestByBucket = new Map<string, { as_of_date: string; value: number | null }>();
  for (const row of points) {
    const d = String(row.as_of_date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const raw = row[valueKey];
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const bucket = d.slice(0, width);
    const prev = latestByBucket.get(bucket);
    if (!prev || prev.as_of_date < d) latestByBucket.set(bucket, { as_of_date: d, value });
  }
  return pickAllTimeHigh([...latestByBucket.values()]);
}

/** Net worth per grid day in `unit` (null where the day's fx/UF is missing — never a carried guess for usd). */
function netWorthInUnitByDay(
  grid: readonly string[],
  unit: TsUnit
): { as_of_date: string; value: number | null }[] {
  const byDate = buildDashboardBucketDailySeriesClp(grid);
  if (unit === "uf") {
    // UF has no on-or-before reader over a range: carry the last published value forward from
    // the grid start, exactly what `ufRowOnOrBefore` would resolve per day.
    const exact = ufClpByDateRange(grid[0]!, grid[grid.length - 1]!);
    let carry = ufRowOnOrBefore(grid[0]!)?.clp_per_uf ?? null;
    return grid.map((ymd) => {
      const clp = byDate.get(ymd)!.net_worth;
      const published = exact.get(ymd);
      if (published != null) carry = published;
      return { as_of_date: ymd, value: carry != null && carry > 0 ? clp / carry : null };
    });
  }
  return grid.map((ymd) => {
    const clp = byDate.get(ymd)!.net_worth;
    const value = unit === "clp" ? clp : clpToUsdForBalanceAt(clp, ymd);
    return { as_of_date: ymd, value: value != null && Number.isFinite(value) ? value : null };
  });
}

/**
 * Cached under the `daily.overview|` prefix on purpose: it is a daily aggregation over the
 * per-account mark series, so it must drop whenever those aggregations drop — the live-quote
 * tick's `live_tail` scope (today's live point can set a new high) and every historical
 * invalidation — while riding the cached marks (a warm rebuild is a Σ over cached rows).
 */
export function getNetWorthAllTimeHigh(unit: TsUnit): NetWorthAthDto | null {
  return getAggregationCached(`daily.overview|ath|${unit}`, () => {
    const endYmd = chileCalendarTodayYmd();
    const grid = chileCalendarDaysListEndingAt(endYmd, totalRangeDays(endYmd));
    return pickAllTimeHigh(netWorthInUnitByDay(grid, unit));
  });
}

/**
 * Decorate a dashboard valuation-timeseries payload's `overview` block with the per-grain ATH
 * (same pattern as `attachColorsToValuationPayload`). The month/year peaks read the block's own
 * points — the rows the monthly chart plots — so they cannot drift from the line.
 */
export function attachNetWorthAth<
  T extends { overview: { points: readonly Record<string, string | number | null>[] } },
>(
  payload: T,
  unit: TsUnit
): Omit<T, "overview"> & { overview: T["overview"] & { ath: NetWorthAthByPeriod } } {
  const points = payload.overview.points;
  const ath: NetWorthAthByPeriod = {
    day: getNetWorthAllTimeHigh(unit),
    month: pickAllTimeHighOnCalendarGrid(points, OVERVIEW_NET_WORTH_KEY, "month"),
    year: pickAllTimeHighOnCalendarGrid(points, OVERVIEW_NET_WORTH_KEY, "year"),
  };
  return { ...payload, overview: { ...payload.overview, ath } };
}
