import {
  type ProportionalSeriesBlock,
} from "./proportionalSeries.js";
import {
  buildCompositionBlock,
  compositionLineSpecsFromNavTree,
  compositionValuesOnGridClp,
} from "./dashboardComposition.js";
import { cacheKeyDailyOverview } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  chileCalendarDaysListEndingAt,
  DAILY_SERIES_MAX_DAYS,
  totalRangeDays,
} from "./dailySeries.js";
import { getNetWorthAllTimeHigh, type NetWorthAthDto } from "./netWorthAllTimeHigh.js";
import {
  buildDashboardBucketDailySeriesClp,
  buildDashboardBucketDailySeriesInUnit,
  dashboardBucketsUsdToday,
} from "./portfolioGroupValueAtDate.js";
import {
  listAccountsForGroupTab,
  milestoneFieldsForDate,
} from "./valuationTimeseries.js";

/**
 * Daily net-worth overview: one point per **calendar day** ending at Chile today (same grid
 * as `dailySeries.ts` — weekends/holidays included, each account flat on its own closed
 * days), each valued by summing per-account marks per bucket
 * (`buildDashboardBucketDailySeriesClp` — the consolidated monthly closing would flatten
 * every day of a month to one value). The last point uses the live mark stack, matching
 * the headline the same way the Rentabilidad strip's live leg does. Served by
 * `GET /api/dashboard/overview-daily`; cached under `daily.overview|…` and dropped with the
 * daily-series namespace.
 */

export type OverviewDailyPoint = {
  as_of_date: string;
  net_worth: number | null;
  real_estate: number | null;
  retirement: number | null;
  brokerage: number | null;
  cash_eqs: number | null;
  /** Retirement + brokerage level (the monthly overview's dashed reference line). */
  invested: number | null;
  /** Pasivos: Σ liability-account marks (mortgage balance + CC owed-on-date). */
  liabilities: number | null;
} & {
  /** USD milestone reference levels (`usd_50k`, …): the US$ amount in the request unit on that
   * day (flat in USD), same keys as the monthly overview's reference lines. */
  [usdMilestoneKey: `usd_${string}`]: number | null;
};

export type OverviewDailyPayload = {
  unit: "clp" | "usd";
  days: number;
  end_ymd: string;
  points: OverviewDailyPoint[];
  /** Composition shares for the home pie-replacement chart (same dataKeys as the monthly block). */
  allocation_proportional: ProportionalSeriesBlock;
  /** All-time high of the net-worth line in the request unit (full-history daily walk, see `netWorthAllTimeHigh.ts`). */
  ath: NetWorthAthDto | null;
};

/** Σ liability-account values per grid day in `unit` (same accounts as the Pasivos group daily view). */
function liabilitiesByDate(grid: readonly string[], unit: "clp" | "usd"): Map<string, number> {
  const rows = listAccountsForGroupTab("liabilities").filter(
    (r) => r.account_id > 0 && r.exclude_from_group_totals !== 1
  );
  const valuesByAccount = rows.map((a) =>
    accountValueSeriesOnGrid(
      {
        account_id: a.account_id,
        bucket_slug: a.bucket_slug,
        import_key: a.import_key ?? null,
        name: a.name ?? null,
      },
      grid,
      unit
    )
  );
  const out = new Map<string, number>();
  grid.forEach((ymd, gi) => {
    let raw = 0;
    for (const values of valuesByAccount) {
      const v = values[gi];
      if (v != null && Number.isFinite(v)) raw += v;
    }
    out.set(ymd, unit === "clp" ? Math.round(raw) : raw);
  });
  return out;
}

function buildOverviewDaily(unit: "clp" | "usd", days: number): OverviewDailyPayload {
  const endYmd = chileCalendarTodayYmd();
  const count = days === 0 ? totalRangeDays(endYmd) : days;
  const grid = chileCalendarDaysListEndingAt(endYmd, count);
  const byDate = buildDashboardBucketDailySeriesClp(grid);
  const liabByDate = liabilitiesByDate(grid, "clp");
  // In USD: Σ of each account's own dollars per day (never the bucket's pesos ÷ one rate).
  const byDateUnit = unit === "clp" ? byDate : buildDashboardBucketDailySeriesInUnit(grid, unit);
  const liabByDateUnit = unit === "clp" ? liabByDate : liabilitiesByDate(grid, unit);

  // Same leading-null convention as the monthly overview: real_estate and liabilities stay
  // null (line not drawn) until their first non-zero value — a flat 0 pre-ownership reads
  // as data, not absence.
  let reStarted = false;
  let liabStarted = false;
  // Today in USD is the headline's figure (Σ of each account's own dollars), never the
  // bucket's pesos ÷ one live rate: a cuota or a pre-open stock is priced on an earlier day.
  const usdToday = unit === "usd" ? dashboardBucketsUsdToday() : null;
  const points: OverviewDailyPoint[] = grid.map((ymd) => {
    const row = byDate.get(ymd)!;
    const isToday = ymd === endYmd && usdToday != null;
    const rowUnit = byDateUnit.get(ymd)!;
    const bucket = (slug: "real_estate" | "retirement" | "brokerage" | "cash_eqs" | "net_worth"): number | null =>
      isToday ? usdToday![slug] : rowUnit[slug];
    if (!reStarted && Math.abs(row.real_estate) >= 0.5) reStarted = true;
    const liabClp = liabByDate.get(ymd)!;
    if (!liabStarted && Math.abs(liabClp) >= 0.5) liabStarted = true;
    return {
      as_of_date: ymd,
      net_worth: bucket("net_worth"),
      real_estate: reStarted ? bucket("real_estate") : null,
      retirement: bucket("retirement"),
      brokerage: bucket("brokerage"),
      cash_eqs: bucket("cash_eqs"),
      invested: isToday ? usdToday!.retirement + usdToday!.brokerage : rowUnit.retirement + rowUnit.brokerage,
      liabilities: liabStarted ? liabByDateUnit.get(ymd)! : null,
      ...milestoneFieldsForDate(ymd, unit),
    };
  });

  // Composition shares (day grain): the same lines and marks as the monthly block, sampled
  // daily (shares are unit-invariant, so the CLP marks serve both units).
  const compositionSpecs = compositionLineSpecsFromNavTree((slug) => listAccountsForGroupTab(slug));
  const allocation_proportional = buildCompositionBlock(
    grid,
    compositionSpecs,
    compositionValuesOnGridClp(compositionSpecs, grid)
  );

  return {
    unit,
    days,
    end_ymd: endYmd,
    points,
    allocation_proportional,
    ath: getNetWorthAllTimeHigh(unit),
  };
}

export const OVERVIEW_DAILY_DEFAULT_DAYS = 90;

/** Validated + aggregation-cached overview series. Throws on an out-of-bounds window. */
export function getDashboardOverviewDaily(
  unit: "clp" | "usd",
  days: number
): OverviewDailyPayload {
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    throw new Error(`overview-daily: days must be 0..${DAILY_SERIES_MAX_DAYS}, got ${days}`);
  }
  return getAggregationCached(cacheKeyDailyOverview(unit, days), () =>
    buildOverviewDaily(unit, days)
  );
}
