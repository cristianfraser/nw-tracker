import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { nwBucketSlugs } from "./navTreeModel.js";
import {
  buildDashboardBucketValueTotals,
  dashboardBucketDayPriorCloses,
  type DashboardBucketValueTotals,
} from "./portfolioGroupValueAtDate.js";

/** Prior bucket closes for the day window — every account marked at yesterday. */
function dailyPriorCloseTotals(priorDayYmd: string, includeUsd: boolean): DashboardBucketValueTotals {
  const { clp, usd } = dashboardBucketDayPriorCloses(priorDayYmd);
  const out: DashboardBucketValueTotals = { net_worth_clp: clp.net_worth };
  for (const slug of nwBucketSlugs()) out[`${slug}_clp`] = clp[slug]!;
  if (!includeUsd) return out;
  out.net_worth_usd = usd.net_worth;
  for (const slug of nwBucketSlugs()) out[`${slug}_usd`] = usd[slug];
  return out;
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

/** Live NW bucket totals + prior period closes (consolidated valuation — overview chart). */
export function buildDashboardNwBucketTotals(includeUsd: boolean): DashboardNwBucketTotals {
  const asOfToday = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", asOfToday);
  const priorYearEnd = priorPeriodEndYmd("ytd", asOfToday);
  const priorDayYmd = chileCalendarAddDays(asOfToday, -1);
  const live = buildDashboardBucketValueTotals(asOfToday, includeUsd);
  const clp: DashboardBucketValueTotals = { net_worth_clp: live.net_worth_clp };
  for (const slug of nwBucketSlugs()) clp[`${slug}_clp`] = live[`${slug}_clp`];
  const usd: Record<`${string}_usd`, number | null | undefined> = { net_worth_usd: live.net_worth_usd };
  for (const slug of nwBucketSlugs()) usd[`${slug}_usd`] = live[`${slug}_usd`];

  return {
    ...clp,
    prior_closes: {
      month_end: priorMonthEnd,
      year_end: priorYearEnd,
      day_end: priorDayYmd,
      month: buildDashboardBucketValueTotals(priorMonthEnd, includeUsd),
      year: buildDashboardBucketValueTotals(priorYearEnd, includeUsd),
      // Per-account raw marks at yesterday — buildDashboardBucketValueTotals maps the
      // consolidated MONTHLY closing onto any date of its month, which would make the
      // prior close equal today's live value (day deltas ≈ 0).
      day: dailyPriorCloseTotals(priorDayYmd, includeUsd),
    },
    ...(includeUsd ? usd : {}),
  };
}
