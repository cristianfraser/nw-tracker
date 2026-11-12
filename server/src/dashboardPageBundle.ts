import { buildInversionesPerfMonthly } from "./inversionesPerfSeries.js";
import { cacheKeyDashboardPageBundle } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { db } from "./db.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries, type TsUnit } from "./valuationTimeseries.js";
import { attachNetWorthAth } from "./netWorthAllTimeHigh.js";
import { buildFxCoverageWithConversionWarnings, type FxCoverage } from "./fxCoverage.js";
import { clearFxConversionWarnings } from "./fxConversionWarnings.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";
import { buildUpcomingPayments } from "./upcomingPayments.js";

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
 * cached error (`cacheRegistry.ts`).
 * @heavy Cold build runs account rows, full valuation TS, group perf charts, and flows deposits.
 */
export function buildDashboardPageBundle(unit: TsUnit): Promise<DashboardPageBundle> {
  return getAggregationCached(cacheKeyDashboardPageBundle(unit), () => {
    return withPortfolioGroupIndex(() => buildDashboardPageBundleInner(unit));
  });
}

/** Let queued I/O (a request, a health check) run before the next heavy piece. */
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The pieces run one after another with a macrotask between them: each is synchronous work on
 * the one thread, and chained as microtasks they would hold the event loop for the whole
 * bundle (a cold build takes many seconds — long enough for a host's health check to fail).
 */
async function buildDashboardPageBundleInner(unit: TsUnit) {
  clearFxConversionWarnings();
  const dash = await timeHeavyAsync(HeavyWork.dashboardPayload, () => buildDashboardPagePayload(unit));
  await nextMacrotask();
  const tsRaw = timeHeavy(HeavyWork.dashboardValuationTimeseries, () =>
    attachNetWorthAth(attachColorsToValuationPayload(getDashboardValuationTimeseries(unit)), unit)
  );
  await nextMacrotask();
  const fx = fxLatestRow() ?? null;
  // The P/L + deposits combo, from the inversiones consolidation and the payload's deposits.
  const depositsMonthly = dash.inversiones_deposits_chart.monthly;
  const inversionesPerf = timeHeavy(HeavyWork.groupMonthlyPerformance, () =>
    buildInversionesPerfMonthly(unit, depositsMonthly)
  );
  await nextMacrotask();
  const upcomingPayments = buildUpcomingPayments(undefined, unit);

  return {
    dash,
    ts: tsRaw,
    fx,
    // The fx coverage concerns every conversion out of pesos (any other unit walks through USD/CLP).
    fx_coverage: unit === "clp" ? null : buildFxCoverageWithConversionWarnings(),
    inversionesPerf,
    upcoming_payments: upcomingPayments,
  };
}
