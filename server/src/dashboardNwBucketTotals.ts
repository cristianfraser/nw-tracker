import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { applyCashSavingsNwAdjustment } from "./cashEqsBucketNet.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import { linkedCreditCardClpForCashCardAsOf } from "./liabilityTree.js";
import { nwDashboardMetricGroupForAccount } from "./portfolioGroupTree.js";
import {
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
  exclude_from_group_totals?: number | null;
  chart_inactive?: boolean | null;
};

function rowCountsTowardBucketTotals(row: DashboardAccountRowForBucketTotals): boolean {
  if (row.exclude_from_group_totals === 1) return false;
  if (row.chart_inactive) return false;
  return row.current_value_clp != null && Number.isFinite(row.current_value_clp);
}

type BucketSumField = "current" | "prior_month" | "prior_year";

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
          : unit === "usd"
            ? row.prior_year_close_usd
            : row.prior_year_close_clp;
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
  const usd = depositClpToUsdAtDate(adjustedClp, asOfYmd);
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

  for (const slug of NW_DASHBOARD_BUCKET_SLUGS) {
    clp[slug] = sumDashboardBucketFromRows(rows, slug, "current", "clp");
    monthClp[slug] = sumDashboardBucketFromRows(rows, slug, "prior_month", "clp");
    yearClp[slug] = sumDashboardBucketFromRows(rows, slug, "prior_year", "clp");
  }

  clp.cash_eqs = cashEqsBucketClpAt(clp.cash_eqs, asOfToday);
  monthClp.cash_eqs = cashEqsBucketClpAt(monthClp.cash_eqs, priorMonthEnd);
  yearClp.cash_eqs = cashEqsBucketClpAt(yearClp.cash_eqs, priorYearEnd);

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
    },
  };
}

/** Live NW bucket totals + prior period closes (consolidated valuation — overview chart). */
export function buildDashboardNwBucketTotals(includeUsd: boolean) {
  const asOfToday = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", asOfToday);
  const priorYearEnd = priorPeriodEndYmd("ytd", asOfToday);
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
      month: buildDashboardBucketValueTotals(priorMonthEnd, includeUsd),
      year: buildDashboardBucketValueTotals(priorYearEnd, includeUsd),
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
