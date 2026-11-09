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
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { cacheKeyDailyReferenceSource } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { accountProfile } from "./accountProfile.js";
import { loanAccountIdOfProperty } from "./accountRoles.js";
import { cashNetOfLinkedCreditCards, groupNetsLinkedCards } from "./cashEqsBucketNet.js";
import { getBucketDailySeriesCached, type DailySeriesAccountLine } from "./dailySeries.js";
import { linkedCreditCardClpForCashCardByDates } from "./liabilityTree.js";
import { clpToUnitAt } from "./clpToUnitAt.js";
import {
  composeReferenceValuesByDate,
  listReferenceGroupsForChartHost,
} from "./portfolioGroupReference.js";
import {
  DEPTO_HIPOTECA_CHART_LINE_NAME,
  DEPTO_VALOR_CHART_LINE_NAME,
  deptoOverlayLineIds,
  deptoOverlayPropertyIds,
  listAccountsForGroupTab,
  type TsUnit,
} from "./valuationTimeseries.js";

/** One overlay line, aligned index-for-index with the daily series' `points`. */
export type DailyReferenceLine = {
  dataKey: string;
  values: (number | null)[];
};

/**
 * Per-date totals of one source group, in the `daily_reference_sources` cache family (dropped
 * with the other daily aggregations). Real clock only, like `getBucketDailySeriesCached`.
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
  const key = cacheKeyDailyReferenceSource(sourceSlug, unit, days);
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
    // one. Per-date, on the daily owed convention, through the one cash netting rule.
    const ccByDate = groupNetsLinkedCards(sourceSlug)
      ? linkedCreditCardClpForCashCardByDates(series.points.map((p) => p.as_of_date))
      : null;
    const now = new Date();
    for (const p of series.points) {
      if (p.value == null || !Number.isFinite(p.value)) continue;
      const ccClp = ccByDate?.get(p.as_of_date) ?? 0;
      const cc = ccClp !== 0 ? clpToUnitAt(ccClp, p.as_of_date, unit, { now, side: "debt" }) : 0;
      out.set(
        p.as_of_date,
        cc != null && Number.isFinite(cc) ? cashNetOfLinkedCreditCards(p.value, cc) : p.value
      );
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
 * One pair per property among `propertyAccountIds` with a loan and ledger rows
 * (`deptoOverlayPropertyIds`, the rule the monthly overlays follow), the first keeping the
 * historical ids (`deptoOverlayLineIds`); a pair whose loan has no value on the grid is left out.
 */
export function deptoPropertyChartOverlayDailyLines(
  propertyAccountIds: readonly number[],
  datesAsc: readonly string[],
  unit: TsUnit
): DailySeriesAccountLine[] {
  if (!datesAsc.length) return [];
  // Each account's own value in the unit per day (converted once at its side: the mortgage
  // as a debt), the same figures its line plots.
  const markValues = (accountId: number): (number | null)[] => {
    const p = accountProfile(accountId);
    return accountValueSeriesOnGrid(
      { account_id: accountId, bucket_slug: p.leafSlug, import_key: p.importKey, name: p.name },
      datesAsc,
      unit
    );
  };
  const out: DailySeriesAccountLine[] = [];
  deptoOverlayPropertyIds(propertyAccountIds).forEach((propertyId, i) => {
    // The property and its loan, read through their roles (`accountRoles.ts`).
    const loanId = loanAccountIdOfProperty(propertyId)!;
    const hipoteca = markValues(loanId);
    if (!hipoteca.some((v) => v != null)) return;
    const equity = markValues(propertyId);
    const ids = deptoOverlayLineIds(propertyId, i === 0);
    out.push(
      { account_id: ids.hipotecaId, name: DEPTO_HIPOTECA_CHART_LINE_NAME, values: hipoteca },
      {
        account_id: ids.valorId,
        name: DEPTO_VALOR_CHART_LINE_NAME,
        values: equity.map((eq, j) => {
          const hip = hipoteca[j];
          return eq != null && hip != null ? eq + hip : null;
        }),
      }
    );
  });
  return out;
}

/** The property accounts of a group's chart (the overlays' scope on a group page). */
export function propertyAccountIdsOfGroup(groupSlug: string): number[] {
  return listAccountsForGroupTab(groupSlug)
    .filter((r) => r.account_id > 0 && accountProfile(r.account_id).quantity.kind === "depto_property")
    .map((r) => r.account_id);
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
