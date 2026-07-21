import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { priorNyseSessionYmd } from "./marketHolidays.js";
import { applyCashSavingsNwAdjustment } from "./cashEqsBucketNet.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { nwDashboardMetricGroupForAccount } from "./portfolioGroupTree.js";
import {
  buildDashboardBucketDailySeriesClp,
  buildDashboardBucketValueTotals,
  NW_DASHBOARD_BUCKET_SLUGS,
  type NwDashboardBucketSlug,
} from "./portfolioGroupValueAtDate.js";

export type DashboardAccountRowForBucketTotals = {
  account_id: number;
  current_value_clp: number | null;
  current_value_usd?: number | null;
  prior_month_close_clp?: number | null;
  prior_month_close_usd?: number | null;
  prior_year_close_clp?: number | null;
  prior_year_close_usd?: number | null;
  prior_day_close_clp?: number | null;
  prior_day_close_usd?: number | null;
  exclude_from_group_totals?: number | null;
  chart_inactive?: boolean | null;
};

function rowCountsTowardBucketTotals(row: DashboardAccountRowForBucketTotals): boolean {
  return row.exclude_from_group_totals !== 1;
}

type BucketSumField = "current" | "prior_month" | "prior_year" | "prior_day";

function sumDashboardBucketFromRows(
  rows: readonly DashboardAccountRowForBucketTotals[],
  bucket: NwDashboardBucketSlug,
  field: BucketSumField,
  unit: "clp" | "usd"
): number {
  let sum = 0;
  for (const row of rows) {
    if (!rowCountsTowardBucketTotals(row)) continue;
    if (nwDashboardMetricGroupForAccount(row.account_id) !== bucket) continue;
    const v =
      field === "current"
        ? unit === "usd"
          ? row.current_value_usd
          : row.current_value_clp
        : field === "prior_month"
          ? unit === "usd"
            ? row.prior_month_close_usd
            : row.prior_month_close_clp
          : field === "prior_day"
            ? unit === "usd"
              ? row.prior_day_close_usd
              : row.prior_day_close_clp
            : unit === "usd"
              ? row.prior_year_close_usd
              : row.prior_year_close_clp;
    if (field === "current") {
      sum += v != null && Number.isFinite(v) ? v : 0;
      continue;
    }
    if (v != null && Number.isFinite(v)) sum += v;
  }
  return Math.round(sum);
}

/** Ahorros y reservas bucket: Σ savings − linked tarjeta (matches chart consolidated NAV). */
function cashEqsBucketClpAt(rawClp: number, asOfYmd: string): number {
  const cc = linkedCreditCardClpForCashCardAsOf(asOfYmd);
  return applyCashSavingsNwAdjustment(rawClp, cc);
}

function cashEqsBucketUsdAt(adjustedClp: number, asOfYmd: string): number {
  const usd = clpToUsdForBalanceAt(adjustedClp, asOfYmd);
  return usd != null && Number.isFinite(usd) ? usd : 0;
}

/** Bucket totals + prior closes summed from the same dashboard account rows (card strip source of truth). */
export function buildDashboardNwBucketTotalsFromRows(
  rows: readonly DashboardAccountRowForBucketTotals[],
  includeUsd: boolean
) {
  const asOfToday = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", asOfToday);
  const priorYearEnd = priorPeriodEndYmd("ytd", asOfToday);
  const priorDayAnchor = priorNyseSessionYmd(asOfToday);

  const clp: Record<NwDashboardBucketSlug, number> = {
    real_estate: 0,
    retirement: 0,
    brokerage: 0,
    cash_eqs: 0,
  };
  const monthClp: Record<NwDashboardBucketSlug, number> = {
    real_estate: 0,
    retirement: 0,
    brokerage: 0,
    cash_eqs: 0,
  };
  const yearClp: Record<NwDashboardBucketSlug, number> = {
    real_estate: 0,
    retirement: 0,
    brokerage: 0,
    cash_eqs: 0,
  };
  const dayClp: Record<NwDashboardBucketSlug, number> = {
    real_estate: 0,
    retirement: 0,
    brokerage: 0,
    cash_eqs: 0,
  };

  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    clp[slug] = sumDashboardBucketFromRows(rows, slug, "current", "clp");
    monthClp[slug] = sumDashboardBucketFromRows(rows, slug, "prior_month", "clp");
    yearClp[slug] = sumDashboardBucketFromRows(rows, slug, "prior_year", "clp");
    dayClp[slug] = sumDashboardBucketFromRows(rows, slug, "prior_day", "clp");
  }

  clp.cash_eqs = cashEqsBucketClpAt(clp.cash_eqs, asOfToday);
  monthClp.cash_eqs = cashEqsBucketClpAt(monthClp.cash_eqs, priorMonthEnd);
  yearClp.cash_eqs = cashEqsBucketClpAt(yearClp.cash_eqs, priorYearEnd);
  if (priorDayAnchor != null) {
    dayClp.cash_eqs = cashEqsBucketClpAt(dayClp.cash_eqs, priorDayAnchor);
  }

  const net_worth_clp = clp.real_estate + clp.retirement + clp.brokerage + clp.cash_eqs;

  const base = {
    net_worth_clp,
    real_estate_clp: clp.real_estate,
    retirement_clp: clp.retirement,
    brokerage_clp: clp.brokerage,
    cash_eqs_clp: clp.cash_eqs,
    prior_closes: {
      month_end: priorMonthEnd,
      year_end: priorYearEnd,
      day_end: priorDayAnchor,
      month: {
        net_worth_clp: monthClp.real_estate + monthClp.retirement + monthClp.brokerage + monthClp.cash_eqs,
        real_estate_clp: monthClp.real_estate,
        retirement_clp: monthClp.retirement,
        brokerage_clp: monthClp.brokerage,
        cash_eqs_clp: monthClp.cash_eqs,
      },
      year: {
        net_worth_clp: yearClp.real_estate + yearClp.retirement + yearClp.brokerage + yearClp.cash_eqs,
        real_estate_clp: yearClp.real_estate,
        retirement_clp: yearClp.retirement,
        brokerage_clp: yearClp.brokerage,
        cash_eqs_clp: yearClp.cash_eqs,
      },
      day: {
        net_worth_clp: dayClp.real_estate + dayClp.retirement + dayClp.brokerage + dayClp.cash_eqs,
        real_estate_clp: dayClp.real_estate,
        retirement_clp: dayClp.retirement,
        brokerage_clp: dayClp.brokerage,
        cash_eqs_clp: dayClp.cash_eqs,
      },
    },
  };

  if (!includeUsd) return base;

  const usd: Record<NwDashboardBucketSlug, number> = {
    real_estate: sumDashboardBucketFromRows(rows, "real_estate", "current", "usd"),
    retirement: sumDashboardBucketFromRows(rows, "retirement", "current", "usd"),
    brokerage: sumDashboardBucketFromRows(rows, "brokerage", "current", "usd"),
    cash_eqs: cashEqsBucketUsdAt(clp.cash_eqs, asOfToday),
  };
  const monthUsd: Record<NwDashboardBucketSlug, number | undefined> = {
    real_estate: sumDashboardBucketFromRows(rows, "real_estate", "prior_month", "usd"),
    retirement: sumDashboardBucketFromRows(rows, "retirement", "prior_month", "usd"),
    brokerage: sumDashboardBucketFromRows(rows, "brokerage", "prior_month", "usd"),
    cash_eqs: cashEqsBucketUsdAt(monthClp.cash_eqs, priorMonthEnd),
  };
  const dayUsd: Record<NwDashboardBucketSlug, number | undefined> = {
    real_estate: sumDashboardBucketFromRows(rows, "real_estate", "prior_day", "usd"),
    retirement: sumDashboardBucketFromRows(rows, "retirement", "prior_day", "usd"),
    brokerage: sumDashboardBucketFromRows(rows, "brokerage", "prior_day", "usd"),
    cash_eqs:
      priorDayAnchor != null ? cashEqsBucketUsdAt(dayClp.cash_eqs, priorDayAnchor) : undefined,
  };

  return {
    ...base,
    net_worth_usd: usd.real_estate + usd.retirement + usd.brokerage + usd.cash_eqs,
    real_estate_usd: usd.real_estate,
    retirement_usd: usd.retirement,
    brokerage_usd: usd.brokerage,
    cash_eqs_usd: usd.cash_eqs,
    prior_closes: {
      ...base.prior_closes,
      month: {
        ...base.prior_closes.month,
        ...(monthUsd.real_estate !== undefined
          ? {
              net_worth_usd:
                (monthUsd.real_estate ?? 0) +
                (monthUsd.retirement ?? 0) +
                (monthUsd.brokerage ?? 0) +
                (monthUsd.cash_eqs ?? 0),
              real_estate_usd: monthUsd.real_estate,
              retirement_usd: monthUsd.retirement,
              brokerage_usd: monthUsd.brokerage,
              cash_eqs_usd: monthUsd.cash_eqs,
            }
          : {}),
      },
      day: {
        ...base.prior_closes.day,
        ...(dayUsd.real_estate !== undefined
          ? {
              net_worth_usd:
                (dayUsd.real_estate ?? 0) +
                (dayUsd.retirement ?? 0) +
                (dayUsd.brokerage ?? 0) +
                (dayUsd.cash_eqs ?? 0),
              real_estate_usd: dayUsd.real_estate,
              retirement_usd: dayUsd.retirement,
              brokerage_usd: dayUsd.brokerage,
              cash_eqs_usd: dayUsd.cash_eqs,
            }
          : {}),
      },
    },
  };
}

/**
 * Prior bucket closes for the day window: market/cash buckets at the prior NYSE session,
 * the UF-marked real_estate bucket at the prior **calendar** day (UF reprices every day).
 * Raw per-date marks + fx at each bucket's own anchor date.
 */
function dailyPriorCloseTotals(
  priorSession: string,
  priorCalendarDay: string,
  includeUsd: boolean
) {
  const dates = [...new Set([priorSession, priorCalendarDay])].sort();
  const byDate = buildDashboardBucketDailySeriesClp(dates);
  const session = byDate.get(priorSession)!;
  const calDay = byDate.get(priorCalendarDay)!;
  const base = {
    real_estate_clp: calDay.real_estate,
    retirement_clp: session.retirement,
    brokerage_clp: session.brokerage,
    cash_eqs_clp: session.cash_eqs,
    net_worth_clp:
      calDay.real_estate + session.retirement + session.brokerage + session.cash_eqs,
  };
  if (!includeUsd) return base;
  const toUsd = (clp: number, ymd: string) => {
    const u = clpToUsdForBalanceAt(clp, ymd);
    return u != null && Number.isFinite(u) ? u : undefined;
  };
  const reUsd = toUsd(calDay.real_estate, priorCalendarDay);
  const retUsd = toUsd(session.retirement, priorSession);
  const brkUsd = toUsd(session.brokerage, priorSession);
  const cashUsd = toUsd(session.cash_eqs, priorSession);
  return {
    ...base,
    net_worth_usd:
      reUsd != null && retUsd != null && brkUsd != null && cashUsd != null
        ? reUsd + retUsd + brkUsd + cashUsd
        : undefined,
    real_estate_usd: reUsd,
    retirement_usd: retUsd,
    brokerage_usd: brkUsd,
    cash_eqs_usd: cashUsd,
  };
}

/** Live NW bucket totals + prior period closes (consolidated valuation — overview chart). */
export function buildDashboardNwBucketTotals(includeUsd: boolean) {
  const asOfToday = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", asOfToday);
  const priorYearEnd = priorPeriodEndYmd("ytd", asOfToday);
  const priorDayAnchor = priorNyseSessionYmd(asOfToday);
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
      day_end: priorDayAnchor,
      month: buildDashboardBucketValueTotals(priorMonthEnd, includeUsd),
      year: buildDashboardBucketValueTotals(priorYearEnd, includeUsd),
      // Per-session raw marks — buildDashboardBucketValueTotals maps the consolidated
      // MONTHLY closing onto any date of its month, which would make the prior-session
      // close equal today's live value (day deltas ≈ 0).
      ...(priorDayAnchor != null
        ? {
            day: dailyPriorCloseTotals(
              priorDayAnchor,
              chileCalendarAddDays(asOfToday, -1),
              includeUsd
            ),
          }
        : {}),
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
