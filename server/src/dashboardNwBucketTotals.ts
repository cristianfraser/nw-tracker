import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { nwBucketSlugs } from "./navTreeModel.js";
import {
  buildDashboardBucketValueTotalsInUnit,
  dashboardBucketDayPriorClosesInUnit,
  type DashboardBucketValueTotals,
} from "./portfolioGroupValueAtDate.js";
import type { TsUnit } from "./rates.js";

/** Prior bucket closes for the day window in `unit` — every account marked at yesterday. */
function dailyPriorCloseTotals(priorDayYmd: string, unit: TsUnit): DashboardBucketValueTotals {
  const values = dashboardBucketDayPriorClosesInUnit(priorDayYmd, unit);
  const buckets: Record<string, number | null> = {};
  for (const slug of nwBucketSlugs()) buckets[slug] = values[slug]!;
  return { net_worth: values.net_worth, buckets };
}

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

/** Live NW bucket totals + prior period closes in `unit` (consolidated valuation — overview chart). */
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
      // Per-account raw marks at yesterday — the consolidated MONTHLY closing maps onto any date
      // of its month, which would make the prior close equal today's live value (day deltas ≈ 0).
      day: dailyPriorCloseTotals(priorDayYmd, unit),
    },
  };
}
