/**
 * Wealth-percentile payload (/wealth-percentile): for every year from portfolio start to
 * today, the user's net worth placed in every seeded country's lognormal wealth
 * distribution (`wealthDistributions.ts`), plus p50/p90/p99 thresholds.
 *
 * One payload carries the whole page — Chile total + financial cells and the four
 * benchmark countries (total mode) — so the net worth per year-end is computed once.
 *
 * - Net worth at each year-end reuses the dashboard bucket primitive
 *   (`buildDashboardBucketValueTotals`): total = the headline NW sum; financial =
 *   total − real_estate. The property account stores equity (gross − hipoteca) and CC debt
 *   nets inside cash_eqs, so the bucket subtraction IS "ex real estate, ex mortgage".
 * - CLP→USD uses the year-end BCentral dólar observado (`fx_daily_bcentral`) — the UBS
 *   databooks use end-of-period official rates. This deliberately differs from the app-wide
 *   Yahoo `fx_daily` display convention and fails fast when the series has no year-end row.
 * - Years after the newest databook row keep the latest distribution
 *   (`distribution_year` < `year` marks them).
 */
import { buildDashboardBucketValueTotals } from "./portfolioGroupValueAtDate.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxBcentralRowOnOrBefore } from "./sbifSyncDb.js";
import { ymdAddDays } from "./fundUnitDaily.js";
import {
  lognormalParamsFor,
  lognormalPercentile,
  lognormalThresholdUsd,
  maxWealthDistributionYear,
  minWealthDistributionYear,
  wealthDistributionRecordFor,
  type LognormalParams,
  type WealthCountry,
  type WealthMode,
} from "./wealthDistributions.js";

/** Max staleness of the fx row behind an as-of date (year-end lookbacks span holidays). */
const FX_MAX_LOOKBACK_DAYS = 21;

export const WEALTH_BENCHMARK_COUNTRIES = [
  "US",
  "ES",
  "CH",
  "UK",
  "AU",
  "DE",
  "JP",
  "MX",
  "BR",
  "CN",
] as const;
export type WealthBenchmarkCountry = (typeof WEALTH_BENCHMARK_COUNTRIES)[number];

/** One net worth placed in one country-mode distribution. */
export type WealthPercentileCell = {
  /** 0–100, or null when the compared net worth ≤ 0 (`below_support`). */
  percentile: number | null;
  below_support: boolean;
  p50_usd: number;
  p90_usd: number;
  p99_usd: number;
  p50_clp: number;
  p90_clp: number;
  p99_clp: number;
};

export type WealthPercentileYearRow = {
  year: number;
  /** Valuation date: YYYY-12-31, or today for the current year. */
  as_of_date: string;
  /** Seed row year backing every cell's distribution (< year once the databook lags). */
  distribution_year: number;
  fx_clp_per_usd: number;
  fx_date: string;
  /** Distribution parameters interpolated across the 2022→2025 methodology break. */
  interpolated: boolean;
  /** CL distribution is an own reconstruction (2025), not an official UBS figure. */
  reconstructed: boolean;
  net_worth_clp: number;
  net_worth_usd: number;
  /** Total − real_estate bucket (ex real estate, ex mortgage). */
  fin_net_worth_clp: number;
  fin_net_worth_usd: number;
  /** Total net worth vs Chile's total-wealth distribution. */
  cl_total: WealthPercentileCell;
  /** Financial net worth vs Chile's financial-wealth distribution. */
  cl_financial: WealthPercentileCell;
  /** Total net worth vs each benchmark country's total-wealth distribution. */
  benchmarks: Record<WealthBenchmarkCountry, WealthPercentileCell>;
};

export type WealthPercentilePayload = {
  rows: WealthPercentileYearRow[];
};

function cellFor(params: LognormalParams, netWorthUsd: number, fxClpPerUsd: number): WealthPercentileCell {
  // CLP thresholds derive from the ROUNDED USD ones so the two unit views stay consistent.
  const p50Usd = Math.round(lognormalThresholdUsd(params, 0.5));
  const p90Usd = Math.round(lognormalThresholdUsd(params, 0.9));
  const p99Usd = Math.round(lognormalThresholdUsd(params, 0.99));
  const belowSupport = !(netWorthUsd > 0);
  return {
    percentile: belowSupport ? null : lognormalPercentile(params, netWorthUsd) * 100,
    below_support: belowSupport,
    p50_usd: p50Usd,
    p90_usd: p90Usd,
    p99_usd: p99Usd,
    p50_clp: Math.round(p50Usd * fxClpPerUsd),
    p90_clp: Math.round(p90Usd * fxClpPerUsd),
    p99_clp: Math.round(p99Usd * fxClpPerUsd),
  };
}

export function buildWealthPercentilePayload(): WealthPercentilePayload {
  const todayYmd = chileCalendarTodayYmd();
  const startYear = Number(portfolioStartYmd().slice(0, 4));
  const currentYear = Number(todayYmd.slice(0, 4));
  const minDistYear = minWealthDistributionYear();
  const maxDistYear = maxWealthDistributionYear();
  if (startYear < minDistYear) {
    throw new Error(
      `wealthPercentile: portfolio starts ${startYear} but distributions begin ${minDistYear} — extend wealthDistributions.ts`
    );
  }

  const rows: WealthPercentileYearRow[] = [];
  for (let year = startYear; year <= currentYear; year++) {
    const asOfYmd = year === currentYear ? todayYmd : `${year}-12-31`;
    const totals = buildDashboardBucketValueTotals(asOfYmd, false);
    const netWorthClp = totals.net_worth_clp;
    const finNetWorthClp = totals.net_worth_clp - totals.real_estate_clp;

    const fxRow = fxBcentralRowOnOrBefore(asOfYmd);
    if (!fxRow) {
      throw new Error(
        `wealthPercentile: no fx_daily_bcentral row on or before ${asOfYmd} — run the sbif_usd sync/backfill`
      );
    }
    if (fxRow.date < ymdAddDays(asOfYmd, -FX_MAX_LOOKBACK_DAYS)) {
      throw new Error(
        `wealthPercentile: fx_daily_bcentral row for ${asOfYmd} is stale (${fxRow.date}) — run the sbif_usd sync/backfill`
      );
    }

    const netWorthUsd = netWorthClp / fxRow.clp_per_usd;
    const finNetWorthUsd = finNetWorthClp / fxRow.clp_per_usd;
    const distributionYear = Math.min(year, maxDistYear);
    const clRecord = wealthDistributionRecordFor("CL", distributionYear);

    const benchmarks = Object.fromEntries(
      WEALTH_BENCHMARK_COUNTRIES.map((country) => [
        country,
        cellFor(lognormalParamsFor(country, distributionYear, "total"), netWorthUsd, fxRow.clp_per_usd),
      ])
    ) as Record<WealthBenchmarkCountry, WealthPercentileCell>;

    rows.push({
      year,
      as_of_date: asOfYmd,
      distribution_year: distributionYear,
      fx_clp_per_usd: fxRow.clp_per_usd,
      fx_date: fxRow.date,
      interpolated: clRecord.interpolated === true,
      reconstructed: clRecord.reconstructed === true,
      net_worth_clp: Math.round(netWorthClp),
      net_worth_usd: Math.round(netWorthUsd),
      fin_net_worth_clp: Math.round(finNetWorthClp),
      fin_net_worth_usd: Math.round(finNetWorthUsd),
      cl_total: cellFor(lognormalParamsFor("CL", distributionYear, "total"), netWorthUsd, fxRow.clp_per_usd),
      cl_financial: cellFor(
        lognormalParamsFor("CL", distributionYear, "financial"),
        finNetWorthUsd,
        fxRow.clp_per_usd
      ),
      benchmarks,
    });
  }

  return { rows };
}

export type { WealthCountry, WealthMode };
