import { getAggregationCached } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { DAILY_SERIES_MAX_DAYS, totalRangeDays } from "./dailySeries.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { buildDashboardBucketDailySeriesClp } from "./portfolioGroupValueAtDate.js";

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
};

export type OverviewDailyPayload = {
  unit: "clp" | "usd";
  days: number;
  end_ymd: string;
  points: OverviewDailyPoint[];
};

function buildOverviewDaily(unit: "clp" | "usd", days: number): OverviewDailyPayload {
  const endYmd = chileCalendarTodayYmd();
  const count = days === 0 ? totalRangeDays(endYmd) : days;
  const grid: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    grid[count - 1 - i] = i === 0 ? endYmd : chileCalendarAddDays(endYmd, -i);
  }
  const byDate = buildDashboardBucketDailySeriesClp(grid);

  const points: OverviewDailyPoint[] = grid.map((ymd) => {
    const row = byDate.get(ymd)!;
    const pick = (clp: number): number | null => {
      if (unit === "clp") return clp;
      const usd = clpToUsdForBalanceAt(clp, ymd);
      return usd != null && Number.isFinite(usd) ? usd : null;
    };
    return {
      as_of_date: ymd,
      net_worth: pick(row.net_worth),
      real_estate: pick(row.real_estate),
      retirement: pick(row.retirement),
      brokerage: pick(row.brokerage),
      cash_eqs: pick(row.cash_eqs),
    };
  });

  return {
    unit,
    days,
    end_ymd: endYmd,
    points,
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
  return getAggregationCached(`daily.overview|${unit}|${days}`, () =>
    buildOverviewDaily(unit, days)
  );
}
