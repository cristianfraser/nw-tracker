/**
 * Day-mode P/L combos, built on the server: a scope's daily P/L with its running YTD and
 * all-time levels anchored on the same scope's monthly rows, so the day-mode areas equal the
 * monthly chart at the end of the window's first month and the client only picks. Group pages
 * anchor on the group consolidation (`getGroupConsolidatedMonthlyRows`), an account page and the
 * mortgage section on the account's own series (`monthlyPerfRowsForAccount`), the home
 * inversiones combo on the inversiones consolidation.
 */

import { pickMonthlyPerfRowsByMonth } from "./accountPeriodMetrics.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import type { BucketDailySeries } from "./dailySeries.js";
import { getGroupConsolidatedMonthlyRows } from "./groupConsolidatedTables.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import type { TsUnit } from "./valuationTimeseries.js";

/** Index-aligned with the daily series' points. */
export type DailyPerfLevels = {
  /** The scope's P/L of the day (the series' bucket `pl`; a day without one reads 0). */
  delta_total: number[];
  /** Running P/L of the calendar year through the day. */
  ytd: number[];
  /** Running P/L since the first month on record through the day. */
  accumulated: number[];
};

type MonthlyAnchorRow = { as_of_date: string; cumulative_nominal_pl: number | null };

const finiteOr0 = (v: number | null | undefined): number =>
  v != null && Number.isFinite(v) ? v : 0;

/**
 * Starting levels for a day window so its running lines meet the monthly chart.
 *
 * `accumulated` is solved at the end of the window's first month M (or today, when M is the
 * month in progress): `cumulative(M) − Σ day deltas from the window start through that day`, so
 * the day-mode «Total acumulado» equals the monthly point of M exactly, and every later
 * month-end as far as the day P/L of each month adds up to that month's monthly P/L. Anchoring
 * on the month-end before the window instead would miss the window month's earlier days.
 *
 * `ytdOffset` is the lifetime P/L through the end of the year before the window's first year
 * (0 when nothing is on record before it): in that first year YTD = accumulated − ytdOffset, so
 * YTD at M's end equals the monthly `ytd_nominal_pl` of M too. Later years in the window restart
 * at 0 on January 1st.
 */
export function anchorDailyLevels(
  datesAsc: readonly string[],
  deltas: readonly number[],
  monthlyAsc: readonly MonthlyAnchorRow[]
): { accumulated: number; ytdOffset: number } {
  if (!datesAsc.length) return { accumulated: 0, ytdOffset: 0 };
  const start = datesAsc[0]!;
  const startMk = monthKeyFromYmd(start);
  const startYear = start.slice(0, 4);
  let cumAtStartMonth = 0;
  let cumBeforeStartYear = 0;
  for (const row of monthlyAsc) {
    const mk = monthKeyFromYmd(row.as_of_date);
    if (mk > startMk) break;
    cumAtStartMonth = finiteOr0(row.cumulative_nominal_pl);
    if (mk.slice(0, 4) < startYear) cumBeforeStartYear = cumAtStartMonth;
  }
  const monthEnd = monthEndUtcYmd(startMk);
  let runThroughMonthEnd = 0;
  for (let i = 0; i < datesAsc.length && datesAsc[i]! <= monthEnd; i++) runThroughMonthEnd += deltas[i]!;
  return { accumulated: cumAtStartMonth - runThroughMonthEnd, ytdOffset: cumBeforeStartYear };
}

/** Running YTD / all-time levels over a day window, anchored by {@link anchorDailyLevels}. */
export function dailyPerfLevelsFromMonthly(
  datesAsc: readonly string[],
  deltas: readonly number[],
  monthlyAsc: readonly MonthlyAnchorRow[]
): DailyPerfLevels {
  if (datesAsc.length !== deltas.length) {
    throw new Error(`dailyPerfLevelsFromMonthly: ${datesAsc.length} dates vs ${deltas.length} deltas`);
  }
  const { accumulated, ytdOffset } = anchorDailyLevels(datesAsc, deltas, monthlyAsc);
  let cumRun = accumulated;
  let ytdRun = accumulated - ytdOffset;
  let year = datesAsc[0]?.slice(0, 4) ?? "";
  const ytd: number[] = [];
  const acc: number[] = [];
  datesAsc.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (y !== year) {
      year = y;
      ytdRun = 0;
    }
    cumRun += deltas[i]!;
    ytdRun += deltas[i]!;
    ytd.push(ytdRun);
    acc.push(cumRun);
  });
  return { delta_total: [...deltas], ytd, accumulated: acc };
}

function seriesDeltas(series: Pick<BucketDailySeries, "points">): {
  dates: string[];
  deltas: number[];
} {
  return {
    dates: series.points.map((p) => p.as_of_date),
    deltas: series.points.map((p) => finiteOr0(p.pl)),
  };
}

/** A group page's day combo: its daily series anchored on the group consolidation. */
export function dailyPerfLevelsForGroup(
  groupSlug: string,
  unit: TsUnit,
  series: Pick<BucketDailySeries, "points">
): DailyPerfLevels {
  const { dates, deltas } = seriesDeltas(series);
  const monthlyAsc = [...getGroupConsolidatedMonthlyRows(groupSlug, unit)].reverse();
  return dailyPerfLevelsFromMonthly(dates, deltas, monthlyAsc);
}

/** An account's day combo: its daily series anchored on its own monthly rows. */
export function dailyPerfLevelsForAccount(
  accountId: number,
  bucketSlug: string,
  unit: TsUnit,
  series: Pick<BucketDailySeries, "points">
): DailyPerfLevels {
  const { dates, deltas } = seriesDeltas(series);
  const monthlyAsc = [...pickMonthlyPerfRowsByMonth(monthlyPerfRowsForAccount(accountId, bucketSlug, unit)).values()];
  return dailyPerfLevelsFromMonthly(dates, deltas, monthlyAsc);
}
