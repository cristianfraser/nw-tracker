import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  buildDashboardBucketValueTotalsInUnit,
  type DashboardBucketValueTotals,
} from "./portfolioGroupValueAtDate.js";
import type { TsUnit } from "./rates.js";

export type DashboardNwBucketTotals = DashboardBucketValueTotals & {
  prior_closes: {
    month_end: string;
    year_end: string;
    day_end: string;
    month: DashboardBucketValueTotals;
    year: DashboardBucketValueTotals;
    day: DashboardBucketValueTotals;
  };
};

/**
 * The headline today and at the prior day / month / year closes in `unit`: one function for all
 * four (`buildDashboardBucketValueTotalsInUnit`), so each adds up to its net worth at the coin.
 */
export function buildDashboardNwBucketTotals(unit: TsUnit): DashboardNwBucketTotals {
  const asOfToday = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", asOfToday);
  const priorYearEnd = priorPeriodEndYmd("ytd", asOfToday);
  const priorDayYmd = chileCalendarAddDays(asOfToday, -1);
  return {
    ...buildDashboardBucketValueTotalsInUnit(asOfToday, unit),
    prior_closes: {
      month_end: priorMonthEnd,
      year_end: priorYearEnd,
      day_end: priorDayYmd,
      month: buildDashboardBucketValueTotalsInUnit(priorMonthEnd, unit),
      year: buildDashboardBucketValueTotalsInUnit(priorYearEnd, unit),
      // Yesterday's close: the same headline, every account at its value that day.
      day: buildDashboardBucketValueTotalsInUnit(priorDayYmd, unit),
    },
  };
}
