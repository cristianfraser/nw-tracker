import {
  accountUsesEquityMtm,
  computeLatestDisplayedEquityClp,
} from "./brokerageEquityMtm.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountUsesCryptoMtm, computeCryptoMtmClpDisplaySync } from "./cryptoValuation.js";
import {
  dashboardCardReconcilePeriodDeltas,
  reconcileDashboardCardMetrics,
} from "./dashboardCardMetricsReconcile.js";
import { dashboardAccountPerfDerived } from "./dashboardAccountCardMetrics.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { priorCloseFromPerfRows, priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import {
  flowsDepositsNetInPeriodByAccount,
  flowsDepositsNetTotalByAccount,
  flowsDepositsNetTotalUsdByAccount,
} from "./flowsDeposits.js";
import {
  getAccountPositionMeta,
  liveFintualCertDisplayValueClp,
  type AccountPositionMeta,
} from "./accountPosition.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { accountIdsWithAnyStaleSyncSource } from "./accountSyncSources.js";
import { syncStatusPayload } from "./globalSyncStale.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashKindSlug, isUsdCashAccount } from "./movementTransfer.js";
import { usdCashBalanceLive, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { isClpCashKindSlug, clpCashBalanceLive } from "./clpCashAccounts.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import { buildFxCoverageWithConversionWarnings } from "./fxCoverage.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";
import {
  convertTs,
  getDashboardChartShape,
  getDashboardOverviewBlock,
  liabilitiesBreakdownClpAsOf,
  type TsUnit,
} from "./valuationTimeseries.js";
import { applyCashSavingsShortfallToDashboardRows } from "./cashEqsBucketNet.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { cashSavingsLinkedBalances } from "./cashEqsBucketNet.js";
import { buildDashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { buildNavCardMetricsBySlug } from "./dashboardNavCardMetrics.js";
import type { InversionesPeriodMetrics } from "./netWorthConsolidation.js";
import { getNetWorthNavGroupNode } from "./navTree.js";
import { inversionesPeriodMetrics } from "./netWorthConsolidation.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  leafPortfolioGroupSlugByAccountIds,
  nwDashboardMetricGroupForAccount,
  withPortfolioGroupIndex,
} from "./portfolioGroupTree.js";
import {
} from "./deptoDividendosLedger.js";
import { db } from "./db.js";
import {
  latestDisplayedBalanceForAccount,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";
import { creditCardFinancingPlSummaryForDashboard } from "./creditCardPerformancePl.js";

const DASHBOARD_ASSET_METRIC_GROUPS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

/** Depto property P/L is UF-based in CLP; USD cards use CLP nominal converted at mark FX. */
function dashboardPropertyDeltaUsd(
  kindSlug: string,
  asOfYmd: string | null,
  deltaClp: number | null | undefined,
  deltaUsdFromPerf: number | null | undefined
): number | null | undefined {
  if (
    accountBucketKindSlug(kindSlug) !== "property" ||
    deltaClp == null ||
    !Number.isFinite(deltaClp)
  ) {
    return deltaUsdFromPerf;
  }
  const usd = convertTs(deltaClp, asOfYmd ?? chileCalendarTodayYmd(), "usd");
  return Number.isFinite(usd) ? usd : deltaUsdFromPerf;
}

export function listDashboardSourceAccounts(): {
  id: number;
  name: string;
  notes: string | null;
  import_key: string | null;
  exclude_from_group_totals: number;
  bucket_slug: string;
  bucket_label: string;
  account_kind: string | null;
  source_account_id: number | null;
}[] {
  return db
    .prepare(
      `
      SELECT a.id, a.name, a.notes, a.import_key, a.exclude_from_group_totals,
             g.slug AS bucket_slug, g.label AS bucket_label,
             a.account_kind, a.source_account_id
      FROM accounts a
      INNER JOIN asset_groups g ON g.id = a.asset_group_id
      WHERE (a.import_key IS NULL OR a.import_key != ?)
        AND g.slug != 'individual_stocks'
        AND NOT (
          g.slug IN ('liabilities', 'credit_cards')
          AND COALESCE(a.account_kind, 'master') = 'master'
          AND EXISTS (
            SELECT 1 FROM accounts v
            WHERE v.source_account_id = a.id AND v.account_kind = 'liability_view'
          )
        )
      ORDER BY g.sort_order, a.id, a.name
    `
    )
    .all(NOTE_STOCKS_LEGACY) as {
    id: number;
    name: string;
    notes: string | null;
    import_key: string | null;
    exclude_from_group_totals: number;
    bucket_slug: string;
    bucket_label: string;
    account_kind: string | null;
    source_account_id: number | null;
  }[];
}

function positionSnapshotFromMeta(
  categorySlug: string | null | undefined,
  meta: AccountPositionMeta | null,
  deposits_clp: number,
  latest: { value_clp: number; as_of_date: string } | null | undefined
): DashboardAccountStats["position"] {
  if (meta == null) return null;
  const afp = categorySlug === "afp";
  const crypto = categorySlug === "bitcoin" || categorySlug === "eth";
  const v = latest?.value_clp;
  const units = meta.units;
  const ovc = meta.afp_override_value_clp;
  const fundUnitMark =
    ovc != null &&
    Number.isFinite(ovc) &&
    ovc > 0 &&
    meta.afp_override_valor_cuota_clp != null &&
    Number.isFinite(meta.afp_override_valor_cuota_clp);
  // Fully-withdrawn cuota/coin position: meta emits ovc = 0 with a date → mark as 0, not stale stored.
  const explicitZeroMark =
    ovc === 0 && meta.afp_override_value_as_of != null && (units == null || units <= 0);
  const mtmMark =
    fundUnitMark ||
    explicitZeroMark ||
    ((afp || crypto) && ovc != null && Number.isFinite(ovc) && (ovc > 0 || (crypto && ovc === 0)));
  const value_clp = mtmMark ? ovc : v != null && Number.isFinite(v) ? v : null;
  const value_as_of = mtmMark ? meta.afp_override_value_as_of ?? null : latest?.as_of_date ?? null;
  const value_per_unit_clp =
    fundUnitMark && meta.afp_override_valor_cuota_clp != null
      ? meta.afp_override_valor_cuota_clp
      : afp && meta.afp_override_valor_cuota_clp != null && Number.isFinite(meta.afp_override_valor_cuota_clp)
        ? meta.afp_override_valor_cuota_clp
        : v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units)
          ? v / units
          : null;
  return {
    ticker: meta.ticker,
    units_kind: meta.units_kind,
    units,
    deposited_clp: deposits_clp,
    value_clp,
    value_as_of,
    value_per_unit_clp,
  };
}

export async function latestValuationDisplayForAccount(
  accountId: number,
  categorySlug?: string | null,
  opts?: { import_key?: string | null; name?: string | null }
): Promise<{ value_clp: number; as_of_date: string } | null> {
  if (opts?.import_key && isFintualCertV2ValuationNotes(opts.import_key)) {
    const live = liveFintualCertDisplayValueClp(accountId, opts.import_key, opts.name ?? null);
    if (live) return live;
  }
  if (categorySlug && isMovementBalanceCashCategory(categorySlug)) {
    return checkingMovementBalanceLive(accountId);
  }
  if (categorySlug && isUsdCashKindSlug(categorySlug)) {
    const live = usdCashBalanceLive(accountId);
    return { value_clp: live.value_clp, as_of_date: live.as_of_date };
  }
  if (categorySlug && isClpCashKindSlug(categorySlug)) {
    return clpCashBalanceLive(accountId);
  }
  const equityTicker = equityTickerForAccount(accountId);
  if (equityTicker != null && accountUsesEquityMtm(accountId)) {
    const eq = computeLatestDisplayedEquityClp(accountId);
    if (eq != null) return eq;
  }
  const isCryptoSlug = categorySlug === "bitcoin" || categorySlug === "eth";
  if (isCryptoSlug || accountUsesCryptoMtm(accountId)) {
    const crypto = computeCryptoMtmClpDisplaySync(accountId);
    if (crypto != null) return crypto;
  }
  const stored = latestDisplayedBalanceForAccount(accountId);
  if (stored?.value_clp != null && stored.value_clp > 0 && stored.as_of_date) {
    return { value_clp: stored.value_clp, as_of_date: stored.as_of_date };
  }
  return null;
}

/** Dashboard nav cards: account rows with balances and P/L metrics (one perf fetch per unit). */
export async function buildDashboardAccountRows(includeUsd: boolean): Promise<DashboardAccountStats[]> {
  return withAccountValuationTsCache(() => buildDashboardAccountRowsInner(includeUsd));
}

async function buildDashboardAccountRowsInner(includeUsd: boolean): Promise<DashboardAccountStats[]> {
  const accounts = listDashboardSourceAccounts();
  const leafSlugByAccount = leafPortfolioGroupSlugByAccountIds(accounts.map((a) => a.id));
  const depositsNetByAccount = flowsDepositsNetTotalByAccount();
  const depositsNetUsdByAccount = includeUsd ? flowsDepositsNetTotalUsdByAccount() : null;
  const depositsMonth = flowsDepositsNetInPeriodByAccount("month");
  const depositsYear = flowsDepositsNetInPeriodByAccount("year");

  const today = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", today);
  const priorYearEnd = priorPeriodEndYmd("ytd", today);
  const staleAccountIds = accountIdsWithAnyStaleSyncSource(syncStatusPayload().stale);

  const rowsBuilt: DashboardAccountStats[] = await Promise.all(
    accounts.map(async (a) => {
      const deposits = depositsNetByAccount.get(a.id) ?? 0;
      const deposits_usd = depositsNetUsdByAccount?.get(a.id) ?? null;
      const leafSlug = a.bucket_slug;
      const kindSlug = accountBucketKindSlug(leafSlug);
      const portfolioLeafSlug = leafSlugByAccount.get(a.id) ?? null;
      const metricGroup = nwDashboardMetricGroupForAccount(a.id) ?? leafSlug;
      const dashboard_bucket_slug = nwDashboardMetricGroupForAccount(a.id);
      const trackAssetMetrics = DASHBOARD_ASSET_METRIC_GROUPS.has(metricGroup);
      const derivedClp = dashboardAccountPerfDerived(a.id, "clp", trackAssetMetrics);
      const derivedUsd =
        trackAssetMetrics && includeUsd ? dashboardAccountPerfDerived(a.id, "usd", true) : null;
      const perfClp = derivedClp.metrics;
      const perfUsd = derivedUsd?.metrics ?? null;
      const perfSeriesClp = trackAssetMetrics ? getAccountMonthlyPerformance(a.id, "clp") : null;
      const markOpts = { import_key: a.import_key, name: a.name };

      /** Asset-group leaf slug (`real_estate__property`), not nav bucket (`real_estate`) — required for depto UF marks. */
      const markCategorySlug = leafSlug;

      let v: { value_clp: number; as_of_date: string } | null = null;
      if (trackAssetMetrics) {
        v = accountMarkClpAtYmd(a.id, today, markCategorySlug, markOpts);
      } else {
        v = await latestValuationDisplayForAccount(a.id, kindSlug, markOpts);
        if (v == null && !isMovementBalanceCashCategory(kindSlug)) {
          const stored = latestValuationRowOnOrBeforeChileToday(a.id);
          if (stored?.value_clp != null && stored.as_of_date) {
            v = { value_clp: stored.value_clp, as_of_date: stored.as_of_date };
          }
        }
      }

      const priorMonthMark = accountMarkClpAtYmd(a.id, priorMonthEnd, markCategorySlug, markOpts);
      const priorYearMark = accountMarkClpAtYmd(a.id, priorYearEnd, markCategorySlug, markOpts);
      const prior_month_close_clp =
        priorMonthMark?.value_clp ??
        (trackAssetMetrics
          ? priorCloseFromPerfRows(perfSeriesClp?.monthly ?? [], "mtd", today) ?? undefined
          : derivedClp.prior_month_close);
      const prior_year_close_clp =
        priorYearMark?.value_clp ??
        (trackAssetMetrics
          ? priorCloseFromPerfRows(perfSeriesClp?.monthly ?? [], "ytd", today) ?? undefined
          : derivedClp.prior_year_close);
      const asOfCuotas = v?.as_of_date ?? chileCalendarTodayYmd();
      const positionMeta = getAccountPositionMeta(a.id, kindSlug, {
        afpCuotasAsOfYmd: kindSlug === "afp" ? asOfCuotas : undefined,
        accountImportKey: a.import_key,
        accountName: a.name,
      });
      const position = positionSnapshotFromMeta(kindSlug, positionMeta, deposits, v ?? undefined);
      let current_value_clp = v?.value_clp ?? null;
      let valuation_as_of = v?.as_of_date ?? null;
      const equityMtm =
        equityTickerForAccount(a.id) != null && accountUsesEquityMtm(a.id);
      if (
        (kindSlug === "afp" ||
          isFintualCertV2ValuationNotes(a.import_key) ||
          ((kindSlug === "bitcoin" || kindSlug === "eth") && accountUsesCryptoMtm(a.id))) &&
        position?.value_clp != null &&
        !equityMtm
      ) {
        current_value_clp = position.value_clp;
        if (position.value_as_of != null) valuation_as_of = position.value_as_of;
      }
      const fxRow = includeUsd ? fxMonthEndForBalanceUsd(valuation_as_of ?? null) : null;
      const current_value_usd = includeUsd
        ? isUsdCashAccount(a.id)
          ? usdCashBalanceUsdAt(a.id, valuation_as_of ?? today)
          : current_value_clp != null && fxRow != null
            ? current_value_clp / fxRow.clp_per_usd
            : null
        : null;
      const fx_missing =
        includeUsd &&
        ((current_value_clp != null && fxRow == null) ||
          (deposits !== 0 && deposits_usd == null));
      const rowBeforeReconcile = {
        account_id: a.id,
        name: a.name,
        group_slug: portfolioLeafSlug ?? leafSlug,
        group_label: a.bucket_label,
        bucket_slug: leafSlug,
        bucket_label: a.bucket_label,
        dashboard_bucket_slug: dashboard_bucket_slug ?? null,
        deposits_clp: deposits,
        deposits_usd: includeUsd ? deposits_usd : undefined,
        delta_month_clp: perfClp?.delta_month,
        delta_month_usd: includeUsd
          ? dashboardPropertyDeltaUsd(
              markCategorySlug,
              valuation_as_of,
              perfClp?.delta_month,
              perfUsd?.delta_month
            )
          : undefined,
        delta_year_clp: perfClp?.delta_year,
        delta_year_usd: includeUsd
          ? dashboardPropertyDeltaUsd(
              markCategorySlug,
              valuation_as_of,
              perfClp?.delta_year,
              perfUsd?.delta_year
            )
          : undefined,
        delta_total_clp: perfClp?.delta_total,
        delta_total_usd: includeUsd
          ? dashboardPropertyDeltaUsd(
              markCategorySlug,
              valuation_as_of,
              perfClp?.delta_total,
              perfUsd?.delta_total
            )
          : undefined,
        deposits_month_clp: trackAssetMetrics ? (depositsMonth.clp.get(a.id) ?? 0) : undefined,
        deposits_month_usd: trackAssetMetrics ? (depositsMonth.usd.get(a.id) ?? null) : undefined,
        deposits_year_clp: trackAssetMetrics ? (depositsYear.clp.get(a.id) ?? 0) : undefined,
        deposits_year_usd: trackAssetMetrics ? (depositsYear.usd.get(a.id) ?? null) : undefined,
        prior_month_close_clp,
        prior_month_close_usd: derivedUsd?.prior_month_close,
        prior_year_close_clp,
        prior_year_close_usd: derivedUsd?.prior_year_close,
        current_value_clp,
        valuation_as_of,
        current_value_usd,
        fx_clp_per_usd: fxRow?.clp_per_usd ?? null,
        fx_date_used: fxRow?.date ?? null,
        fx_missing: includeUsd ? fx_missing : undefined,
        notes: a.notes ?? null,
        exclude_from_group_totals: a.exclude_from_group_totals,
        chart_inactive: accountChartInactive(a.id),
        position,
        sync_stale: staleAccountIds.has(a.id),
      };
      const reconciled = reconcileDashboardCardMetrics(rowBeforeReconcile, {
        includeUsd,
        reconcilePeriodDeltas: dashboardCardReconcilePeriodDeltas(metricGroup),
      });

      if (kindSlug === "credit_card") {
        const masterAccountId = a.source_account_id ?? a.id;
        const todayYm = today.slice(0, 7);
        const plSummary = creditCardFinancingPlSummaryForDashboard(masterAccountId, todayYm);
        if (plSummary !== null) {
          reconciled.delta_total_clp = -plSummary.cumulative_clp;
          reconciled.delta_month_clp = -plSummary.current_month_clp;
          reconciled.delta_year_clp = -plSummary.ytd_clp;
          if (includeUsd && fxRow != null) {
            const rate = fxRow.clp_per_usd;
            reconciled.delta_total_usd = -plSummary.cumulative_clp / rate;
            reconciled.delta_month_usd = -plSummary.current_month_clp / rate;
            reconciled.delta_year_usd = -plSummary.ytd_clp / rate;
          }
        } else {
          reconciled.delta_total_clp = null;
          reconciled.delta_month_clp = null;
          reconciled.delta_year_clp = null;
          if (includeUsd) {
            reconciled.delta_total_usd = null;
            reconciled.delta_month_usd = null;
            reconciled.delta_year_usd = null;
          }
        }
      }

      return { ...rowBeforeReconcile, ...reconciled } as DashboardAccountStats;
    })
  );
  return applyCashSavingsShortfallToDashboardRows(
    rowsBuilt,
    chileCalendarTodayYmd(),
    includeUsd
  );
}

/** Nav cards strip + account detail row lookup (no full dashboard totals/charts). */
/** @heavy One {@link getAccountMonthlyPerformance} per tracked account (via {@link buildDashboardAccountRows}). */
export async function buildDashboardNavSnapshot(
  includeUsd: boolean,
  opts?: {
    /** Consolidated inversiones slice for the hub parent card — nav-context passes the slice it serves; the standalone snapshot has none. */
    inversiones?: InversionesPeriodMetrics | null;
  }
) {
  const rowsBuilt = await buildDashboardAccountRows(includeUsd);
  const clientAccounts = rowsBuilt.map(({ notes, ...rest }) => ({
    ...rest,
    notes: notes ?? null,
  }));
  const asOfToday = chileCalendarTodayYmd();
  const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday);
  const liabilities_breakdown = {
    mortgage_clp: liabilitiesClp.mortgage_clp,
    credit_card_clp: liabilitiesClp.credit_card_clp,
    mortgage_usd: depositClpToUsdAtDate(liabilitiesClp.mortgage_clp, asOfToday),
    credit_card_usd: depositClpToUsdAtDate(liabilitiesClp.credit_card_clp, asOfToday),
  };
  const dashboard_layout = getDashboardLayoutCards().map((card) =>
    card.slug === "cash_eqs"
      ? {
          ...card,
          linked_balances: cashSavingsLinkedBalances(asOfToday, includeUsd),
        }
      : card
  );
  const nw_bucket_totals = buildDashboardNwBucketTotals(includeUsd);
  // Nav-strip card metrics, precomputed server-side (see dashboardNavCardMetrics.ts).
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav snapshot: net_worth nav tree missing");
  const card_metrics_by_slug = buildNavCardMetricsBySlug({
    navRoot,
    rows: rowsBuilt,
    totals: nw_bucket_totals,
    inversiones: opts?.inversiones ?? null,
  });
  return {
    accounts: clientAccounts,
    liabilities_breakdown,
    dashboard_layout,
    nw_bucket_totals,
    card_metrics_by_slug,
    chart_shape: getDashboardChartShape(),
  };
}

/**
 * Nav strip + overview chart in one response (single HTTP round-trip).
 * Runs account rows and full dashboard valuation TS in parallel on the server.
 */
export async function buildDashboardNavContext(includeUsd: boolean, unit: TsUnit) {
  return withPortfolioGroupIndex(() => buildDashboardNavContextInner(includeUsd, unit));
}

async function buildDashboardNavContextInner(includeUsd: boolean, unit: TsUnit) {
  // Same inversiones slice feeds both the payload field and the hub card metrics, so the
  // inversiones parent card always matches the served consolidated series.
  const inversiones = inversionesPeriodMetrics(unit);
  const [nav, ts] = await Promise.all([
    timeHeavyAsync(HeavyWork.navContext, () => buildDashboardNavSnapshot(includeUsd, { inversiones })),
    Promise.resolve().then(() =>
      timeHeavy(HeavyWork.dashboardOverviewBlock, () => getDashboardOverviewBlock(unit))
    ),
  ]);
  return {
    accounts: nav.accounts,
    liabilities_breakdown: nav.liabilities_breakdown,
    dashboard_layout: nav.dashboard_layout,
    nw_bucket_totals: nav.nw_bucket_totals,
    card_metrics_by_slug: nav.card_metrics_by_slug,
    inversiones_period_metrics: inversiones,
    overview: ts,
    fx_coverage: includeUsd ? buildFxCoverageWithConversionWarnings() : null,
  };
}
