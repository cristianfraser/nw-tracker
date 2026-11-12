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
 * - Display unit (`?unit=`, any core currency): the distributions are USD-native, so the
 *   percentile is always computed in USD at the observado and the `p*_usd` thresholds stay as
 *   printed. The user's net worth and the thresholds are then expressed in the unit at the same
 *   year-end: pesos are the native frame, USD is the observado itself (so a USD threshold reads
 *   as printed), any other unit its stored CLP rate on or before the as-of day through
 *   `rates.ts` (EUR: Banco Central's `eur_daily`, the same official source as the observado).
 */
import { buildDashboardBucketValueTotals } from "./portfolioGroupValueAtDate.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { fxBcentralRowOnOrBefore } from "./sbifSyncDb.js";
import { ymdAddDays } from "./fundUnitDaily.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { convertCurrency, type DisplayUnitCode } from "./rates.js";
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
  /** The distribution's thresholds as printed (USD). */
  p50_usd: number;
  p90_usd: number;
  p99_usd: number;
  /** The same thresholds in the payload's unit at the row's year-end rate. */
  p50: number;
  p90: number;
  p99: number;
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
  /** CLP per one unit of the payload's `unit` at the row's year-end (1 for CLP, the observado for USD). */
  clp_per_unit: number;
  /** Net worth in the payload's unit. */
  net_worth: number;
  /** Total − real_estate bucket (ex real estate, ex mortgage), in the payload's unit. */
  fin_net_worth: number;
  /** Total net worth vs Chile's total-wealth distribution. */
  cl_total: WealthPercentileCell;
  /** Financial net worth vs Chile's financial-wealth distribution. */
  cl_financial: WealthPercentileCell;
  /** Total net worth vs each benchmark country's total-wealth distribution. */
  benchmarks: Record<WealthBenchmarkCountry, WealthPercentileCell>;
};

export type WealthPercentilePayload = {
  unit: DisplayUnitCode;
  rows: WealthPercentileYearRow[];
};

/**
 * CLP per one `unit` at `asOfYmd`: 1 for pesos; the observado for USD (the frame the USD
 * distributions are compared in); any other unit its stored rate on or before the day
 * (`rates.ts`, read as of the next day so today's row never takes a live quote).
 */
function clpPerUnitAt(unit: DisplayUnitCode, asOfYmd: string, observadoClpPerUsd: number): number {
  if (unit === "clp") return 1;
  if (unit === "usd") return observadoClpPerUsd;
  const asOfNextDay = new Date(`${chileCalendarAddDays(asOfYmd, 1)}T16:00:00Z`);
  const r = convertCurrency(1, unit, "clp", asOfYmd, { side: "mid", now: asOfNextDay });
  if (r == null || !(r > 0)) {
    throw new Error(`wealthPercentile: no ${unit}/CLP rate on or before ${asOfYmd}`);
  }
  return r;
}

function cellFor(
  params: LognormalParams,
  netWorthUsd: number,
  fxClpPerUsd: number,
  clpPerUnit: number
): WealthPercentileCell {
  // Unit thresholds derive from the ROUNDED USD ones so the unit views stay consistent.
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
    p50: Math.round((p50Usd * fxClpPerUsd) / clpPerUnit),
    p90: Math.round((p90Usd * fxClpPerUsd) / clpPerUnit),
    p99: Math.round((p99Usd * fxClpPerUsd) / clpPerUnit),
  };
}

export function buildWealthPercentilePayload(unit: DisplayUnitCode = "clp"): WealthPercentilePayload {
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
    const clpPerUnit = clpPerUnitAt(unit, asOfYmd, fxRow.clp_per_usd);
    const finNetWorthUsd = finNetWorthClp / fxRow.clp_per_usd;
    const distributionYear = Math.min(year, maxDistYear);
    const clRecord = wealthDistributionRecordFor("CL", distributionYear);

    const benchmarks = Object.fromEntries(
      WEALTH_BENCHMARK_COUNTRIES.map((country) => [
        country,
        cellFor(lognormalParamsFor(country, distributionYear, "total"), netWorthUsd, fxRow.clp_per_usd, clpPerUnit),
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
      clp_per_unit: clpPerUnit,
      net_worth: Math.round(netWorthClp / clpPerUnit),
      fin_net_worth: Math.round(finNetWorthClp / clpPerUnit),
      cl_total: cellFor(lognormalParamsFor("CL", distributionYear, "total"), netWorthUsd, fxRow.clp_per_usd, clpPerUnit),
      cl_financial: cellFor(
        lognormalParamsFor("CL", distributionYear, "financial"),
        finNetWorthUsd,
        fxRow.clp_per_usd,
        clpPerUnit
      ),
      benchmarks,
    });
  }

  return { unit, rows };
}

export type { WealthCountry, WealthMode };
