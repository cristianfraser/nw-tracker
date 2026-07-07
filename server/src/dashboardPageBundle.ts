import { getGroupMonthlyPerformanceSeries } from "./accountPerformance.js";
import {
  cacheKeyDashboardPageBundle,
  getAggregationCached,
  invalidateDashboardPageBundle,
} from "./aggregationCache.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { db } from "./db.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries, type TsUnit } from "./valuationTimeseries.js";
import { buildFxCoverageWithConversionWarnings, type FxCoverage } from "./fxCoverage.js";
import { clearFxConversionWarnings } from "./fxConversionWarnings.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";

export type { FxCoverage };

function fxLatestRow() {
  return db
    .prepare(
      `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
    )
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_usd: number } | undefined;
}

export type DashboardPageBundle = Awaited<ReturnType<typeof buildDashboardPageBundleInner>>;

/**
 * One server-side build for the home dashboard (replaces 5 parallel HTTP calls from the client).
 * Served from the aggregation cache (`dashboard.page_bundle|<unit>`): the warmer repopulates
 * both units after every invalidation, so interactive requests normally return the prebuilt
 * object. The cached value is the in-flight promise — concurrent cold requests share one
 * build; a rejected build evicts itself so the next request retries instead of replaying the
 * cached error.
 * @heavy Cold build runs account rows, full valuation TS, group perf charts, and flows deposits.
 */
export function buildDashboardPageBundle(unit: TsUnit): Promise<DashboardPageBundle> {
  return getAggregationCached(cacheKeyDashboardPageBundle(unit), () => {
    const built = withPortfolioGroupIndex(() => buildDashboardPageBundleInner(unit));
    built.catch(() => invalidateDashboardPageBundle());
    return built;
  });
}

async function buildDashboardPageBundleInner(unit: TsUnit) {
  clearFxConversionWarnings();
  const includeUsd = unit === "usd";
  const [dash, tsRaw, fx, retirementPerf, brokeragePerf] = await Promise.all([
    timeHeavyAsync(HeavyWork.dashboardPayload, () => buildDashboardPagePayload(includeUsd)),
    Promise.resolve().then(() =>
      timeHeavy(HeavyWork.dashboardValuationTimeseries, () =>
        attachColorsToValuationPayload(getDashboardValuationTimeseries(unit))
      )
    ),
    Promise.resolve(fxLatestRow() ?? null),
    Promise.resolve().then(() =>
      timeHeavy(HeavyWork.groupMonthlyPerformance, () =>
        getGroupMonthlyPerformanceSeries("retirement", unit)
      )
    ),
    Promise.resolve().then(() =>
      timeHeavy(HeavyWork.groupMonthlyPerformance, () =>
        getGroupMonthlyPerformanceSeries("brokerage", unit)
      )
    ),
  ]);

  return {
    dash,
    ts: tsRaw,
    fx,
    fx_coverage: includeUsd ? buildFxCoverageWithConversionWarnings() : null,
    retirementPerf,
    brokeragePerf,
  };
}
