import { cachedGroupResponse } from "./aggregationCache.js";
import { attachColorsToValuationPayload } from "./chartColorRgb.js";
import { getGroupConsolidatedTables, getGroupPeriodReturns } from "./groupConsolidatedTables.js";
import { getGroupMonthlyPlSeries } from "./groupMonthlyPlSeries.js";
import { getGroupValuationTimeseries, type TsUnit } from "./valuationTimeseries.js";

/**
 * A group page's cached responses (`cachedGroupResponse`), one function each so the routes and the
 * visited-pages warm (`visitedPagesWarm.ts`) build them under the same keys from the same code.
 */
export function groupValuationTsResponse(slug: string, unit: TsUnit) {
  return cachedGroupResponse("valuation_ts", slug, unit, () =>
    attachColorsToValuationPayload(getGroupValuationTimeseries(slug, unit, undefined, { groupedBlocks: true }))
  );
}

export function groupConsolidatedTablesResponse(slug: string, unit: TsUnit) {
  return cachedGroupResponse("consolidated_tables", slug, unit, () => getGroupConsolidatedTables(slug, unit, undefined));
}

export function groupMonthlyPlSeriesResponse(slug: string, unit: TsUnit) {
  return cachedGroupResponse("monthly_pl_series", slug, unit, () =>
    getGroupMonthlyPlSeries(slug, unit, { groupedBlocks: true })
  );
}

export function groupPeriodReturnsResponse(slug: string, unit: TsUnit) {
  return cachedGroupResponse("period_returns", slug, unit, () => {
    const { unit: u, group_slug, period_returns } = getGroupPeriodReturns(slug, unit);
    return { unit: u, group_slug, period_returns };
  });
}
