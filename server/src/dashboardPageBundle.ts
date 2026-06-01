import { getGroupMonthlyPerformanceSeries } from "./accountPerformance.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { db } from "./db.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getDashboardValuationTimeseries, type TsUnit } from "./valuationTimeseries.js";
import { buildFxCoverage, type FxCoverage } from "./fxCoverage.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";

export type { FxCoverage };

function fxLatestRow() {
  return db
    .prepare(
      `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
    )
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_usd: number } | undefined;
}

/**
 * One server-side build for the home dashboard (replaces 5 parallel HTTP calls from the client).
 * @heavy Runs account rows, full valuation TS, group perf charts, and flows deposits.
 */
export async function buildDashboardPageBundle(unit: TsUnit) {
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
    fx_coverage: includeUsd ? buildFxCoverage() : null,
    retirementPerf,
    brokeragePerf,
  };
}
