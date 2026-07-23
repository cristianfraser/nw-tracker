/**
 * Reference overlay lines for the **daily** group charts — the Pasivos «Disponible» /
 * «Disponible total» and the Efectivo «Tarjeta de crédito», which the monthly path builds in
 * `appendChartHostReferenceOverlays` (`valuationTimeseries.ts`).
 *
 * Same definitions, same composer: `portfolio_groups.group_kind = 'reference'` rows keyed by
 * `chart_host_slug`, each a weighted sum of *other* nav groups' totals. Nothing here knows a
 * slug — a new reference node starts working with no code change.
 *
 * What differs from the monthly path is the source totals. A reference line needs only Σ marks
 * per date, so this builds **values only**: no flow legs, no aportes-acum companions, no
 * per-account lines. That is most of the cost of a full daily series (cash_eqs is the slowest
 * source at 5y despite having 6 accounts, because its USD-cash flow legs telescope
 * balance − interest at every date), and the overlay would throw all of it away.
 *
 * The value leg itself is `bucketValueInUnitAt` — the same helper `getBucketDailySeries` sums
 * inline — so a reference line equals the sum of its source groups' own daily Totals by
 * construction.
 */
import { getAggregationCached } from "./aggregationCache.js";
import { isCashEqsNwValuationGroupSlug } from "./assetGroupTree.js";
import { linkedCreditCardClpForCashCardByDates } from "./liabilityTree.js";
import {
  bucketValueInUnitAt,
  convertLegToUnit,
  includeShortHorizonAccount,
} from "./periodReturnsShortHorizon.js";
import {
  composeReferenceValuesByDate,
  listReferenceGroupsForChartHost,
  portfolioGroupApiForValuation,
} from "./portfolioGroupReference.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/** One overlay line, aligned index-for-index with the daily series' `points`. */
export type DailyReferenceLine = {
  dataKey: string;
  values: (number | null)[];
};

/**
 * Per-date totals of one source group over `datesAsc`, cached under the `daily.` namespace so
 * `invalidateDailySeries()` (both write funnels + day rollover) drops it with the rest of the
 * daily aggregations. Real clock only, like `getBucketDailySeriesCached`.
 */
function sourceGroupDailyValues(
  sourceSlug: string,
  unit: TsUnit,
  days: number,
  datesAsc: readonly string[]
): Map<string, number> {
  const key = `daily.refsrc|${sourceSlug}|${unit}|${days}`;
  return getAggregationCached(key, () => {
    const { groupSlug, tabSubgroup } = portfolioGroupApiForValuation(sourceSlug);
    const accounts = listAccountsForGroupTab(groupSlug, tabSubgroup).filter(
      includeShortHorizonAccount
    );
    const now = new Date();
    const out = new Map<string, number>();
    if (!accounts.length) return out;
    // A cash bucket's canonical Total is CC-netted (`netLinkedCreditCardFromCashConsolidated`
    // feeds the monthly chart Total via `applyConsolidatedTotalToGroupTabBlock`), so the
    // overlay has to net too or the daily line sits a whole card balance above the monthly
    // one. Per-date, on the daily owed convention.
    const ccByDate = isCashEqsNwValuationGroupSlug(groupSlug)
      ? linkedCreditCardClpForCashCardByDates([...datesAsc])
      : null;
    for (const ymd of datesAsc) {
      const v = bucketValueInUnitAt(accounts, ymd, unit, now);
      if (v == null || !Number.isFinite(v)) continue;
      const ccClp = ccByDate?.get(ymd) ?? 0;
      const cc = ccClp !== 0 ? convertLegToUnit(ccClp, ymd, unit, now) : 0;
      out.set(ymd, Number.isFinite(cc) ? v - cc : v);
    }
    return out;
  });
}

/**
 * Overlay lines for a chart host over the daily grid, or null when the host declares none.
 * Values are `null` on dates no source could mark (never a fake 0 for the whole line); a
 * single missing source contributes 0 to the weighted sum, as in the monthly composer.
 */
export function dailyReferenceLinesForChartHost(
  chartHostSlug: string,
  unit: TsUnit,
  days: number,
  datesAsc: readonly string[]
): DailyReferenceLine[] | null {
  const defs = listReferenceGroupsForChartHost(chartHostSlug);
  if (!defs.length || !datesAsc.length) return null;

  const totalsBySource = new Map<string, Map<string, number>>();
  for (const def of defs) {
    for (const link of def.links) {
      if (totalsBySource.has(link.source_slug)) continue;
      totalsBySource.set(
        link.source_slug,
        sourceGroupDailyValues(link.source_slug, unit, days, datesAsc)
      );
    }
  }

  const dates = [...datesAsc];
  const valuesByDataKey = composeReferenceValuesByDate(defs, totalsBySource, dates);
  const anySourceMarked = (ymd: string): boolean => {
    for (const totals of totalsBySource.values()) if (totals.has(ymd)) return true;
    return false;
  };

  const lines: DailyReferenceLine[] = [];
  for (const def of defs) {
    const byDate = valuesByDataKey.get(def.dataKey);
    if (!byDate) continue;
    lines.push({
      dataKey: def.dataKey,
      values: dates.map((d) => {
        if (!anySourceMarked(d)) return null;
        const v = byDate.get(d);
        return v != null && Number.isFinite(v) ? v : null;
      }),
    });
  }
  return lines.length ? lines : null;
}
