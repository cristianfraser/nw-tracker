import { getAggregationCached } from "./aggregationCache.js";
import { markJsonResponseCacheable } from "./jsonResponse.js";
import { accountBucketKindSlug, bucketSlugForAccountId, isLiabilityKindSlug } from "./accountBucket.js";
import { ccDailyHistorialBlockForGroup, ccDailyHistorialBlockForMasters } from "./ccDailyHistorialBlock.js";
import { dailyPerfLevelsForAccount, dailyPerfLevelsForGroup } from "./dailyPerfLevels.js";
import { dailyReferenceLinesForChartHost, deptoPropertyChartOverlayDailyLines } from "./dailyReferenceLines.js";
import { groupDailySeriesAccounts } from "./dailySeries.js";
import { dbInTransaction } from "./db.js";
import {
  buildLiabilitiesChartBucketPlan,
  buildNavChartBucketPlan,
  shouldAggregateLiabilitiesCharts,
  shouldAggregateNavCharts,
  type ChartBucketPlan,
} from "./groupChartBuckets.js";
import { resolveAccountDailySeries, resolveGroupDailySeries } from "./groupDailySeries.js";
import { HeavyWork, timeHeavy } from "./heavyWork.js";
import { getNavChartGroupNodeBySlug } from "./navTree.js";
import { chartHostSlugForValuationGroup, listReferenceGroupsForChartHost } from "./portfolioGroupReference.js";
import { buildProportionalFromValueArrays } from "./proportionalSeries.js";
import { buildReferenceCoverage, sumAlignedValues } from "./referenceCoverage.js";
import type { TsUnit } from "./valuationTimeseries.js";

/** Prefix of every cached daily-series response, group and account (dropped by API writes too). */
export const DAILY_SERIES_RESPONSE_PREFIX = "daily.series|response|";
/** Prefix of the cached group daily-series responses. */
export const GROUP_DAILY_RESPONSE_PREFIX = `${DAILY_SERIES_RESPONSE_PREFIX}group|`;
/** Prefix of the cached account daily-series responses. */
export const ACCOUNT_DAILY_RESPONSE_PREFIX = `${DAILY_SERIES_RESPONSE_PREFIX}account|`;

/**
 * `GET /api/daily-series?portfolio_group=` for one group: the bucket series with its chart lines,
 * the reference overlays, composition shares, coverage, bucket lines, the card historial block
 * and (on request) the P/L levels; null for a group without accounts. Cached under the daily
 * namespace (its invalidations, a live tick only where it read a moved price, API writes); built
 * afresh inside a transaction.
 */
export function groupDailySeriesResponse(portfolioGroup: string, unit: TsUnit, days: number, wantPerfLevels: boolean) {
  const build = () => buildGroupDailySeriesResponse(portfolioGroup, unit, days, wantPerfLevels);
  if (dbInTransaction()) return build();
  return getAggregationCached(
    `${GROUP_DAILY_RESPONSE_PREFIX}${portfolioGroup}|${unit}|${days}|${wantPerfLevels ? "perf" : "plain"}`,
    () => markJsonResponseCacheable(build())
  );
}

function buildGroupDailySeriesResponse(portfolioGroup: string, unit: TsUnit, days: number, wantPerfLevels: boolean) {
  const series = timeHeavy(`${HeavyWork.dailyGroupSeries} ${portfolioGroup} ${unit} ${days}`, () =>
    resolveGroupDailySeries(portfolioGroup, unit, days)
  );
  if (!series) return null;
  // Bucket lines when the page has bucket nodes — same plans (synthetic ids/names) as
  // the monthly grouped blocks, so the client reuses those blocks' series metadata.
  // Pasivos pages use the liabilities plan (issuer/mortgage buckets, single-mode); nav
  // pages additionally get the "Sin agrupar" plan (one nav level deeper) when it differs,
  // so hub pages (e.g. Inversiones) show second-level buckets with Agrupado off instead
  // of the raw per-leaf lines.
  const navNode = getNavChartGroupNodeBySlug(portfolioGroup);
  const isLiabilities = navNode ? shouldAggregateLiabilitiesCharts(navNode) : false;
  const plan = navNode
    ? isLiabilities
      ? buildLiabilitiesChartBucketPlan(navNode)
      : shouldAggregateNavCharts(navNode, true)
        ? buildNavChartBucketPlan(navNode, true)
        : null
    : null;
  const ungroupedCandidate =
    navNode && !isLiabilities && shouldAggregateNavCharts(navNode, false)
      ? buildNavChartBucketPlan(navNode, false)
      : null;
  // Leaf pages resolve both modes to the same buckets — skip the redundant twin payload
  // (the client reuses `grouped_accounts` for the ungrouped view; same plan, same ids).
  const ungroupedPlan: ChartBucketPlan | null =
    ungroupedCandidate &&
    ungroupedCandidate.orderedKeys.join("|") !== (plan?.orderedKeys.join("|") ?? "")
      ? ungroupedCandidate
      : null;
  // Chart-host overlays («Disponible» on Pasivos, «Tarjeta de crédito» on Efectivo): the
  // monthly block carries them in `lines`, so the daily view needs the same values on the
  // same grid. Values only — the client pairs them with that block's line metadata.
  const chartHost = chartHostSlugForValuationGroup(portfolioGroup);
  const referenceLines = chartHost
    ? timeHeavy(`${HeavyWork.dailyReferenceLines} ${chartHost} ${unit} ${days}`, () =>
        dailyReferenceLinesForChartHost(
          chartHost,
          unit,
          days,
          series.points.map((p) => p.as_of_date)
        )
      )
    : null;
  // Composition shares (pie-replacement chart, day grain): per-account and, when the
  // page has bucket nodes, per grouped bucket line. Names/ids come from the same line
  // metadata the valuation chart uses; the client colors by account_id like the pie did.
  const dailyDates = series.points.map((p) => p.as_of_date);
  const shareLines = (
    lines: { account_id: number; name: string | null; values: (number | null)[] }[] | undefined
  ) =>
    (lines ?? [])
      .filter((l) => Number.isFinite(l.account_id))
      .map((l) => ({
        dataKey: String(l.account_id),
        name: l.name ?? String(l.account_id),
        account_id: l.account_id,
        values: l.values,
      }));
  const proportional = series.accounts?.length
    ? buildProportionalFromValueArrays(dailyDates, shareLines(series.accounts))
    : undefined;
  // `deposit_cums_raw` is builder-internal (feeds the grouped-bucket aportes below) —
  // never serialized.
  const { deposit_cums_raw: _rawDeps, ...seriesPayload } = series;
  // Liabilities coverage by the same overlays (Pasivos), the daily twin of the monthly
  // `reference_coverage` block: the total owed (mortgage + cards) on each day.
  const liabilityLines = (series.accounts ?? []).filter(
    (l) => l.account_id > 0 && isLiabilityKindSlug(accountBucketKindSlug(bucketSlugForAccountId(l.account_id) ?? ""))
  );
  const referenceCoverage =
    chartHost && referenceLines?.length && liabilityLines.length
      ? buildReferenceCoverage(
          dailyDates,
          sumAlignedValues(
            liabilityLines.map((l) => l.values),
            dailyDates.length
          ),
          listReferenceGroupsForChartHost(chartHost).flatMap((d) => {
            const line = referenceLines.find((r) => r.dataKey === d.dataKey);
            return line
              ? [
                  {
                    dataKey: d.dataKey,
                    name: d.label,
                    ...(d.label_i18n_key ? { name_i18n_key: d.label_i18n_key } : {}),
                    ...(d.color_rgb ? { color_rgb: d.color_rgb } : {}),
                    values: line.values,
                  },
                ]
              : [];
          })
        )
      : null;
  const withRefs = {
    ...(referenceLines?.length ? { ...seriesPayload, reference_lines: referenceLines } : seriesPayload),
    ...(proportional ? { proportional } : {}),
    ...(referenceCoverage ? { reference_coverage: referenceCoverage } : {}),
  };
  const bucketLines = (bucketPlan: ChartBucketPlan | null) => {
    if (!bucketPlan) return null;
    const lines = groupDailySeriesAccounts(series, bucketPlan);
    return lines?.length ? lines : null;
  };
  const grouped = bucketLines(plan);
  const ungrouped = bucketLines(ungroupedPlan);
  // Real-estate chart: the monthly block appends synthetic «hipoteca»/«valor» lines —
  // emit their daily twins so the M↔D toggle keeps them. Appended AFTER the proportional
  // shares and bucket plans are built: reference overlays are not holdings, so they must
  // not enter composition shares or bucket sums (the monthly path excludes them the same
  // way, via the `valueSeriesType === "data"` filter).
  const groupOverlays =
    portfolioGroup === "real_estate" && withRefs.accounts?.length
      ? deptoPropertyChartOverlayDailyLines(dailyDates, unit)
      : [];
  // Pasivos root / credit-card group / issuer pages: the day-period CC historial lines
  // (owed, plan debt, plan tail) summed over the masters the merged monthly ledger sums, plus
  // each card's facturación bars on its close dates — CLP-native like the chart, so CLP
  // requests only (the client asks for clp explicitly).
  const ccDaily = unit === "clp" ? ccDailyHistorialBlockForGroup(portfolioGroup, series) : null;
  return {
    ...withRefs,
    ...(wantPerfLevels ? { perf_levels: dailyPerfLevelsForGroup(portfolioGroup, unit, series) } : {}),
    ...(groupOverlays.length ? { accounts: [...withRefs.accounts!, ...groupOverlays] } : {}),
    ...(ccDaily ?? {}),
    ...(grouped
      ? {
          grouped_accounts: grouped,
          grouped_proportional: buildProportionalFromValueArrays(dailyDates, shareLines(grouped)),
        }
      : {}),
    ...(ungrouped
      ? {
          ungrouped_accounts: ungrouped,
        }
      : {}),
  };
}

export type AccountDailySeriesRow = {
  account_id: number;
  name: string;
  bucket_slug: string;
  import_key: string | null;
};

/**
 * `GET /api/daily-series?account_id=` for one account: its bucket series with its chart line, the
 * property's «hipoteca»/«valor» overlays, a card's historial block (CLP only) and (on request) the
 * P/L levels. Cached beside the group responses (same invalidations; the account's name is in
 * the payload, so API writes drop it too); built afresh inside a transaction.
 */
export function accountDailySeriesResponse(
  row: AccountDailySeriesRow,
  unit: TsUnit,
  days: number,
  wantPerfLevels: boolean
) {
  const build = () => buildAccountDailySeriesResponse(row, unit, days, wantPerfLevels);
  if (dbInTransaction()) return build();
  return getAggregationCached(
    `${ACCOUNT_DAILY_RESPONSE_PREFIX}${row.account_id}|${row.bucket_slug}|${unit}|${days}|${wantPerfLevels ? "perf" : "plain"}`,
    () => markJsonResponseCacheable(build())
  );
}

function buildAccountDailySeriesResponse(
  row: AccountDailySeriesRow,
  unit: TsUnit,
  days: number,
  wantPerfLevels: boolean
) {
  const accountId = row.account_id;
  // Excluded-from-totals accounts still get their own daily series on their page.
  const series = resolveAccountDailySeries(row, unit, days);
  const { deposit_cums_raw: _rawDepsAcct, ...accountSeriesBase } = series;
  const accountSeriesPayload = wantPerfLevels
    ? {
        ...accountSeriesBase,
        perf_levels: dailyPerfLevelsForAccount(accountId, row.bucket_slug, unit, series),
      }
    : accountSeriesBase;
  // Property account page: the monthly block carries synthetic «hipoteca»/«valor» reference
  // lines beside the property line — emit their daily twins (matched by account id in the
  // client's metadata borrow) or the overlays vanish in day mode.
  if (accountBucketKindSlug(row.bucket_slug) === "property" && accountSeriesPayload.accounts?.length) {
    const overlays = deptoPropertyChartOverlayDailyLines(
      series.points.map((p) => p.as_of_date),
      unit
    );
    if (overlays.length) {
      accountSeriesPayload.accounts = [...accountSeriesPayload.accounts, ...overlays];
    }
  }
  // CC masters: attach the day-period historial series — owed, plan debt («deuda en cuotas»),
  // the future plan tail (today+1 .. plan end) and the facturación bars on their close dates —
  // so the account page's daily historial has both lines and the bars and covers the same
  // window as its monthly/yearly forms. CLP-native like the chart, so CLP requests only (the
  // client asks for clp explicitly).
  if (accountBucketKindSlug(row.bucket_slug) === "credit_card" && unit === "clp") {
    const ccDaily = ccDailyHistorialBlockForMasters([accountId], series);
    if (ccDaily) return { ...accountSeriesPayload, ...ccDaily };
  }
  return accountSeriesPayload;
}
