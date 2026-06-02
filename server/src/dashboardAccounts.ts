import {
  accountUsesEquityMtm,
  computeLatestDisplayedEquityClp,
} from "./brokerageEquityMtm.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { accountUsesCryptoMtm, computeCryptoMtmClpDisplaySync } from "./cryptoValuation.js";
import { reconcileDashboardCardMetrics } from "./dashboardCardMetricsReconcile.js";
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
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { checkingMovementBalanceLive } from "./checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { depositClpToUsdAtDate } from "./flowsDeposits.js";
import { buildFxCoverage } from "./fxCoverage.js";
import { timeHeavy, timeHeavyAsync, HeavyWork } from "./heavyWork.js";
import {
  getDashboardOverviewBlock,
  liabilitiesBreakdownClpAsOf,
  type TsUnit,
} from "./valuationTimeseries.js";
import { applyCashSavingsShortfallToDashboardRows } from "./cashEqsBucketNet.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { cashSavingsLinkedBalances } from "./cashEqsBucketNet.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import {
  kindSlugForAccount,
  leafPortfolioGroupSlugForAccount,
  nwDashboardMetricGroupForAccount,
} from "./portfolioGroupTree.js";
import { db } from "./db.js";
import {
  latestDisplayedBalanceForAccount,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";

const DASHBOARD_ASSET_METRIC_GROUPS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

export function listDashboardSourceAccounts(): {
  id: number;
  name: string;
  notes: string | null;
  exclude_from_group_totals: number;
  bucket_slug: string;
  bucket_label: string;
}[] {
  return db
    .prepare(
      `
      SELECT a.id, a.name, a.notes, a.exclude_from_group_totals,
             g.slug AS bucket_slug, g.label AS bucket_label
      FROM accounts a
      INNER JOIN asset_groups g ON g.id = a.asset_group_id
      WHERE (a.notes IS NULL OR a.notes != ?)
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
    exclude_from_group_totals: number;
    bucket_slug: string;
    bucket_label: string;
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
  const mtmMark =
    fundUnitMark ||
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
  opts?: { notes?: string | null; name?: string | null }
): Promise<{ value_clp: number; as_of_date: string } | null> {
  if (opts?.notes && isFintualCertV2ValuationNotes(opts.notes)) {
    const live = liveFintualCertDisplayValueClp(accountId, opts.notes, opts.name ?? null);
    if (live) return live;
  }
  if (categorySlug && isMovementBalanceCashCategory(categorySlug)) {
    return checkingMovementBalanceLive(accountId);
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
  const accounts = listDashboardSourceAccounts();
  const depositsNetByAccount = flowsDepositsNetTotalByAccount();
  const depositsNetUsdByAccount = includeUsd ? flowsDepositsNetTotalUsdByAccount() : null;
  const depositsMonth = flowsDepositsNetInPeriodByAccount("month");
  const depositsYear = flowsDepositsNetInPeriodByAccount("year");

  const today = chileCalendarTodayYmd();
  const priorMonthEnd = priorPeriodEndYmd("mtd", today);
  const priorYearEnd = priorPeriodEndYmd("ytd", today);

  const rowsBuilt: DashboardAccountStats[] = await Promise.all(
    accounts.map(async (a) => {
      const deposits = depositsNetByAccount.get(a.id) ?? 0;
      const deposits_usd = depositsNetUsdByAccount?.get(a.id) ?? null;
      const leafSlug = a.bucket_slug;
      const kindSlug = kindSlugForAccount(a.id) ?? leafSlug;
      const portfolioLeafSlug = leafPortfolioGroupSlugForAccount(a.id);
      const metricGroup = nwDashboardMetricGroupForAccount(a.id) ?? leafSlug;
      const trackAssetMetrics = DASHBOARD_ASSET_METRIC_GROUPS.has(metricGroup);
      const derivedClp = dashboardAccountPerfDerived(a.id, "clp", trackAssetMetrics);
      const derivedUsd =
        trackAssetMetrics && includeUsd ? dashboardAccountPerfDerived(a.id, "usd", true) : null;
      const perfClp = derivedClp.metrics;
      const perfUsd = derivedUsd?.metrics ?? null;
      const perfSeriesClp = trackAssetMetrics ? getAccountMonthlyPerformance(a.id, "clp") : null;
      const markOpts = { notes: a.notes, name: a.name };

      let v: { value_clp: number; as_of_date: string } | null = null;
      if (trackAssetMetrics) {
        v = accountMarkClpAtYmd(a.id, today, kindSlug, markOpts);
      } else {
        v = await latestValuationDisplayForAccount(a.id, kindSlug, markOpts);
        if (v == null && !isMovementBalanceCashCategory(kindSlug)) {
          const stored = latestValuationRowOnOrBeforeChileToday(a.id);
          if (stored?.value_clp != null && stored.as_of_date) {
            v = { value_clp: stored.value_clp, as_of_date: stored.as_of_date };
          }
        }
      }

      const priorMonthMark = accountMarkClpAtYmd(a.id, priorMonthEnd, kindSlug, markOpts);
      const priorYearMark = accountMarkClpAtYmd(a.id, priorYearEnd, kindSlug, markOpts);
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
        accountNotes: a.notes,
        accountName: a.name,
      });
      const position = positionSnapshotFromMeta(kindSlug, positionMeta, deposits, v ?? undefined);
      let current_value_clp = v?.value_clp ?? null;
      let valuation_as_of = v?.as_of_date ?? null;
      const equityMtm =
        equityTickerForAccount(a.id) != null && accountUsesEquityMtm(a.id);
      if (
        (kindSlug === "afp" ||
          isFintualCertV2ValuationNotes(a.notes) ||
          ((kindSlug === "bitcoin" || kindSlug === "eth") && accountUsesCryptoMtm(a.id))) &&
        position?.value_clp != null &&
        !equityMtm
      ) {
        current_value_clp = position.value_clp;
        if (position.value_as_of != null) valuation_as_of = position.value_as_of;
      }
      const fxRow = includeUsd ? fxMonthEndForBalanceUsd(valuation_as_of ?? null) : null;
      const current_value_usd =
        includeUsd && current_value_clp != null && fxRow != null
          ? current_value_clp / fxRow.clp_per_usd
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
        dashboard_bucket_slug: null,
        deposits_clp: deposits,
        deposits_usd: includeUsd ? deposits_usd : undefined,
        delta_month_clp: perfClp?.delta_month,
        delta_month_usd: perfUsd?.delta_month,
        delta_year_clp: perfClp?.delta_year,
        delta_year_usd: perfUsd?.delta_year,
        delta_total_clp: perfClp?.delta_total,
        delta_total_usd: perfUsd?.delta_total,
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
      };
      const reconciled = reconcileDashboardCardMetrics(rowBeforeReconcile, { includeUsd });
      return { ...rowBeforeReconcile, ...reconciled };
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
export async function buildDashboardNavSnapshot(includeUsd: boolean) {
  const rowsBuilt = await buildDashboardAccountRows(includeUsd);
  const clientAccounts = rowsBuilt.map(({ notes, ...rest }) => ({
    ...rest,
    notes: notes ?? null,
  }));
  const asOfToday = chileCalendarTodayYmd();
  const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday, { mortgageFromDeptoSheet: true });
  const liabilities_breakdown = {
    mortgage_clp: liabilitiesClp.mortgage_clp,
    credit_card_clp: liabilitiesClp.credit_card_clp,
    mortgage_usd: depositClpToUsdAtDate(liabilitiesClp.mortgage_clp, asOfToday),
    credit_card_usd: depositClpToUsdAtDate(liabilitiesClp.credit_card_clp, asOfToday),
  };
  const dashboard_layout = getDashboardLayoutCards().map((card) =>
    card.slug === "cash_savings"
      ? {
          ...card,
          linked_balances: cashSavingsLinkedBalances(asOfToday, includeUsd),
        }
      : card
  );
  return { accounts: clientAccounts, liabilities_breakdown, dashboard_layout };
}

/**
 * Nav strip + overview chart in one response (single HTTP round-trip).
 * Runs account rows and full dashboard valuation TS in parallel on the server.
 */
export async function buildDashboardNavContext(includeUsd: boolean, unit: TsUnit) {
  const [nav, ts] = await Promise.all([
    timeHeavyAsync(HeavyWork.navContext, () => buildDashboardNavSnapshot(includeUsd)),
    Promise.resolve().then(() =>
      timeHeavy(HeavyWork.dashboardOverviewBlock, () => getDashboardOverviewBlock(unit))
    ),
  ]);
  return {
    accounts: nav.accounts,
    liabilities_breakdown: nav.liabilities_breakdown,
    dashboard_layout: nav.dashboard_layout,
    overview: ts,
    fx_coverage: includeUsd ? buildFxCoverage() : null,
  };
}
