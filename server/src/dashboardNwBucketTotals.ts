import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  buildDashboardBucketValueTotals,
  dashboardBucketDayPriorCloses,
} from "./portfolioGroupValueAtDate.js";

/** Prior bucket closes for the day window — every account marked at yesterday. */
function dailyPriorCloseTotals(priorDayYmd: string, includeUsd: boolean) {
  const { clp, usd } = dashboardBucketDayPriorCloses(priorDayYmd);
  const base = {
    net_worth_clp: clp.net_worth,
    real_estate_clp: clp.real_estate,
    retirement_clp: clp.retirement,
    brokerage_clp: clp.brokerage,
    cash_eqs_clp: clp.cash_eqs,
  };
  if (!includeUsd) return base;
  return {
    ...base,
    net_worth_usd: usd.net_worth,
    real_estate_usd: usd.real_estate,
    retirement_usd: usd.retirement,
    brokerage_usd: usd.brokerage,
    cash_eqs_usd: usd.cash_eqs,
  };
}

/** Live NW bucket totals + prior period closes (consolidated valuation — overview chart). */
export function buildDashboardNwBucketTotals(includeUsd: boolean) {
  const asOfToday = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", asOfToday);
  const priorYearEnd = priorPeriodEndYmd("ytd", asOfToday);
  const priorDayYmd = chileCalendarAddDays(asOfToday, -1);
  const live = buildDashboardBucketValueTotals(asOfToday, includeUsd);

  return {
    net_worth_clp: live.net_worth_clp,
    real_estate_clp: live.real_estate_clp,
    retirement_clp: live.retirement_clp,
    brokerage_clp: live.brokerage_clp,
    cash_eqs_clp: live.cash_eqs_clp,
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
    ...(includeUsd
      ? {
          net_worth_usd: live.net_worth_usd,
          real_estate_usd: live.real_estate_usd,
          retirement_usd: live.retirement_usd,
          brokerage_usd: live.brokerage_usd,
          cash_eqs_usd: live.cash_eqs_usd,
        }
      : {}),
  };
}
