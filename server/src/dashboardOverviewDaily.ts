import { getAggregationCached } from "./aggregationCache.js";
import { DAILY_SERIES_MAX_SESSIONS } from "./dailySeries.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { nyseSessionsListEndingAt } from "./marketHolidays.js";
import { isNyseRegularSessionOpen, nyseDisplaySessionYmd } from "./nyseSession.js";
import { buildDashboardBucketDailySeriesClp } from "./portfolioGroupValueAtDate.js";

/**
 * Daily net-worth overview: one point per NYSE session (same grid + "vs last workday"
 * semantics as `dailySeries.ts`), each valued by summing per-account marks per bucket
 * (`buildDashboardBucketDailySeriesClp` — the consolidated monthly closing would flatten
 * every session of a month to one value). The last point uses the live mark stack, matching
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
  sessions: number;
  end_session_ymd: string;
  /** True while the NYSE regular session is open (the last point tracks live marks). */
  d1_is_live: boolean;
  points: OverviewDailyPoint[];
};

function buildOverviewDaily(unit: "clp" | "usd", sessions: number): OverviewDailyPayload {
  const now = new Date();
  const endSession = nyseDisplaySessionYmd(now);
  const grid = nyseSessionsListEndingAt(endSession, sessions);
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
    sessions,
    end_session_ymd: endSession,
    d1_is_live: isNyseRegularSessionOpen(now),
    points,
  };
}

export const OVERVIEW_DAILY_DEFAULT_SESSIONS = 90;

/** Validated + aggregation-cached overview series. Throws on an out-of-bounds window. */
export function getDashboardOverviewDaily(
  unit: "clp" | "usd",
  sessions: number
): OverviewDailyPayload {
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > DAILY_SERIES_MAX_SESSIONS) {
    throw new Error(
      `overview-daily: sessions must be 1..${DAILY_SERIES_MAX_SESSIONS}, got ${sessions}`
    );
  }
  return getAggregationCached(`daily.overview|${unit}|${sessions}`, () =>
    buildOverviewDaily(unit, sessions)
  );
}
