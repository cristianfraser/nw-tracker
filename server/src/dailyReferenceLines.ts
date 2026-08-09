/**
 * Reference overlay lines for the **daily** group charts — the Pasivos «Disponible» /
 * «Disponible total» and the Efectivo «Tarjeta de crédito», which the monthly path builds in
 * `appendChartHostReferenceOverlays` (`valuationTimeseries.ts`).
 *
 * Same definitions, same composer: `portfolio_groups.group_kind = 'reference'` rows keyed by
 * `chart_host_slug`, each a weighted sum of *other* nav groups' totals. Nothing here knows a
 * slug — a new reference node starts working with no code change.
 *
 * What differs from the monthly path is where the source totals come from: a source group's
 * daily Total is exactly what its OWN daily page already builds, so this asks
 * `getBucketDailySeriesCached` for it with that page's scope key, rows and options. One build
 * then serves both — opening Pasivos warms Brokerage/Efectivo/APV in day mode and vice versa,
 * where a private values-only build would pay for identical marks twice (marks dominate the
 * cost of a daily series; the flow legs this would skip are the cheap part).
 */
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import { getAggregationCached } from "./aggregationCache.js";
import { isCashEqsNwValuationGroupSlug } from "./assetGroupTree.js";
import { getBucketDailySeriesCached, type DailySeriesAccountLine } from "./dailySeries.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { linkedCreditCardClpForCashCardByDates } from "./liabilityTree.js";
import { convertLegToUnit } from "./periodReturnsShortHorizon.js";
import {
  composeReferenceValuesByDate,
  listReferenceGroupsForChartHost,
} from "./portfolioGroupReference.js";
import {
  DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
  DEPTO_HIPOTECA_CHART_LINE_NAME,
  DEPTO_VALOR_CHART_ACCOUNT_ID,
  DEPTO_VALOR_CHART_LINE_NAME,
  listAccountsForGroupTab,
  type TsUnit,
} from "./valuationTimeseries.js";
import { accountBucketKindSlug } from "./accountBucket.js";

/** One overlay line, aligned index-for-index with the daily series' `points`. */
export type DailyReferenceLine = {
  dataKey: string;
  values: (number | null)[];
};

/**
 * Per-date totals of one source group, keyed under the `daily.` namespace so
 * `invalidateDailySeries()` (both write funnels + day rollover) drops it with the rest of the
 * daily aggregations. Real clock only, like `getBucketDailySeriesCached`.
 *
 * The heavy part — the per-day marks — comes from that group's own daily series under the very
 * scope key its page uses (`pg:<slug>` + the same rows and options as the `/api/daily-series`
 * group branch), so the two never build the same marks twice. This thin per-unit map stays
 * cached on top because the CC netting below is not free to redo per request.
 */
function sourceGroupDailyValues(
  sourceSlug: string,
  unit: TsUnit,
  days: number
): Map<string, number> {
  const key = `daily.refsrc|${sourceSlug}|${unit}|${days}`;
  return getAggregationCached(key, () => {
    const out = new Map<string, number>();
    const rows = listAccountsForGroupTab(sourceSlug).filter((r) => r.account_id > 0);
    if (!rows.length) return out;
    const series = getBucketDailySeriesCached(`pg:${sourceSlug}`, rows, {
      unit,
      days,
      includeAccounts: true,
    });
    // A cash bucket's canonical Total is CC-netted (`netLinkedCreditCardFromCashConsolidated`
    // feeds the monthly chart Total via `applyConsolidatedTotalToGroupTabBlock`), so the
    // overlay has to net too or the daily line sits a whole card balance above the monthly
    // one. Per-date, on the daily owed convention.
    const ccByDate = isCashEqsNwValuationGroupSlug(sourceSlug)
      ? linkedCreditCardClpForCashCardByDates(series.points.map((p) => p.as_of_date))
      : null;
    const now = new Date();
    for (const p of series.points) {
      if (p.value == null || !Number.isFinite(p.value)) continue;
      const ccClp = ccByDate?.get(p.as_of_date) ?? 0;
      const cc = ccClp !== 0 ? convertLegToUnit(ccClp, p.as_of_date, unit, now) : 0;
      out.set(p.as_of_date, Number.isFinite(cc) ? p.value - cc : p.value);
    }
    return out;
  });
}

/**
 * Daily twins of the monthly synthetic property-chart overlays the property account page and
 * the real_estate group chart append (`valuationTimeseries.ts`, same account ids): «hipoteca»
 * (the linked mortgage's balance per calendar day) and «valor» (gross property value =
 * equity + mortgage). Emitted as extra `accounts` entries so the client's
 * borrow-the-monthly-metadata rule (`buildDailyValuationBlock` matches by `account_id`)
 * keeps the lines across the M↔D toggle — without this the overlays silently vanished in
 * day mode. Values come from the accounts' daily marks (`accountMarkClpSeriesOnGrid`,
 * already cached per account): the mortgage mark is the same depto-ledger balance the
 * monthly `deptoMortgageBalanceClpBySnapshotDates` reads, and the property mark is exactly
 * the equity the payload's own property line plots, so valor = equity + hipoteca holds
 * point-for-point.
 *
 * Empty when there is not exactly one mortgage tab account (the depto ledger models one
 * mortgage — the monthly overlays rest on the same assumption); «valor» additionally needs
 * exactly one property account.
 */
export function deptoPropertyChartOverlayDailyLines(
  datesAsc: readonly string[],
  unit: TsUnit
): DailySeriesAccountLine[] {
  if (!datesAsc.length) return [];
  const mortgageRows = listLiabilitiesTabAccountRows("mortgage");
  if (mortgageRows.length !== 1) return [];
  const now = new Date();
  const markValues = (r: {
    account_id: number;
    bucket_slug: string;
    import_key?: string | null;
    name?: string | null;
  }): (number | null)[] =>
    accountMarkClpSeriesOnGrid(
      {
        account_id: r.account_id,
        bucket_slug: r.bucket_slug,
        import_key: r.import_key ?? null,
        name: r.name ?? null,
      },
      datesAsc
    ).map((clp, i) =>
      clp != null && Number.isFinite(clp) ? convertLegToUnit(clp, datesAsc[i]!, unit, now) : null
    );

  const hipoteca = markValues(mortgageRows[0]!);
  if (!hipoteca.some((v) => v != null)) return [];
  const lines: DailySeriesAccountLine[] = [
    {
      account_id: DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
      name: DEPTO_HIPOTECA_CHART_LINE_NAME,
      values: hipoteca,
    },
  ];

  const propertyRows = listAccountsForGroupTab("real_estate").filter(
    (r) => r.account_id > 0 && accountBucketKindSlug(r.bucket_slug) === "property"
  );
  if (propertyRows.length === 1) {
    const equity = markValues(propertyRows[0]!);
    lines.push({
      account_id: DEPTO_VALOR_CHART_ACCOUNT_ID,
      name: DEPTO_VALOR_CHART_LINE_NAME,
      values: equity.map((eq, i) => {
        const hip = hipoteca[i];
        return eq != null && hip != null ? eq + hip : null;
      }),
    });
  }
  return lines;
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
      totalsBySource.set(link.source_slug, sourceGroupDailyValues(link.source_slug, unit, days));
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
