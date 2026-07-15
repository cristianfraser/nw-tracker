import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { ExportToolbarButton } from "../components/export/ExportModal";
import { GroupChartViewToggles } from "../components/group/GroupChartViewToggles";
import { PortfolioGroupChartsSection } from "../components/charts/PortfolioGroupChartsSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayPieSlices,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import type { AssetGroupSlug } from "../types";
import { findBestNavNodeForPathname, resolveGroupPageApiParams } from "../portfolioNavFromApi";
import { enrichNavTreeWithAllAccounts } from "../navAccountsTreeEnrich";
import { navColorTargetFromDto, resolveNavTreeLabel } from "../sidebarNavFromApi";
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { pathnameUsesDashboardNavContext } from "../dashboardNavContextRoutes";
import { Trans, useTranslation } from "../i18n";
import { prefetchPortfolioGroupBundle } from "../queries/displayUnitQueries";
import { extractGroupPageShellFromReal } from "../placeholders/groupPageShellFromNav";
import { buildPlaceholderPortfolioGroupBundle } from "../placeholders/groupPageChartPlaceholders";
import {
  convertPortfolioGroupBundleUnit,
  resolveClpPerUsdForKeepPrev,
} from "../placeholders/keepPrevBundleUnit";
import { readFxLatestCache } from "../queries/fxLatestCache";
import { dashPickForNavStrip } from "../queries/fetchers";
import { writeGroupPageShellCache } from "../queries/groupPageShellCache";
import { hasDashboardNavSnapshotCache } from "../queries/dashboardNavSnapshotCache";
import { queryKeys } from "../queries/keys";
import { isBundleContentLoading, isPageShapeLoading, useRealBundleForContent } from "../queries/pageShapeReady";
import {
  useAccountsByPortfolioGroup,
  useDashboardNavContext,
  useDashboardNavSnapshot,
  useGroupPageShell,
  usePortfolioGroupBundle,
  useSidebarNav,
} from "../queries/hooks";
/** Portfolio / asset-class group page: shared shell via {@link GroupInfoBase}, group-specific charts. */
export function GroupInfoPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav();
  const navStillLoading = (navPending || navFetching) && sidebarNav == null;
  const hasNavSnapshotCache = hasDashboardNavSnapshotCache(displayUnit);

  const navMatchNode = useMemo(
    () => findBestNavNodeForPathname(sidebarNav?.main, pathname),
    [sidebarNav, pathname]
  );

  const apiParams = navMatchNode ? resolveGroupPageApiParams(navMatchNode) : null;
  const portfolioGroup = apiParams?.portfolio_group ?? "";

  const queryClient = useQueryClient();
  const shapeEnabled = Boolean(navMatchNode && portfolioGroup);
  const { data: navSnapshot, isPending: navSnapshotPending } = useDashboardNavSnapshot(
    displayUnit,
    shapeEnabled
  );
  const { data: shapeAccounts, isPending: accountsShapePending } = useAccountsByPortfolioGroup(
    portfolioGroup,
    displayUnit,
    shapeEnabled
  );

  const { data: shell } = useGroupPageShell({
    portfolioGroup,
    unit: displayUnit,
    navNode: navMatchNode,
    enabled: shapeEnabled,
  });

  const {
    data,
    error,
    isPending: groupPending,
    isPlaceholderData,
  } = usePortfolioGroupBundle({
    portfolio_group: portfolioGroup,
    unit: displayUnit,
    enabled: Boolean(navMatchNode && portfolioGroup),
  });

  useEffect(() => {
    if (!portfolioGroup) return;
    void prefetchPortfolioGroupBundle(queryClient, {
      portfolio_group: portfolioGroup,
      unit: displayUnit,
    });
  }, [queryClient, portfolioGroup, displayUnit]);

  const [chartsGrouped, setChartsGrouped] = useState(true);
  const [showValuationDeposits, setShowValuationDeposits] = useState(true);

  useEffect(() => {
    setChartsGrouped(true);
  }, [pathname]);

  const placeholderFirstMonth = shell?.first_month ?? navSnapshot?.chart_shape?.first_month;
  const placeholderBundle = useMemo(
    () =>
      buildPlaceholderPortfolioGroupBundle(
        displayUnit,
        shell?.accounts ?? [],
        portfolioGroup,
        placeholderFirstMonth
      ),
    [displayUnit, shell?.accounts, portfolioGroup, placeholderFirstMonth]
  );
  const bundleReady = Boolean(data?.ts?.accounts_in_group && data.ts.group_allocation_pie);
  const useRealBundle = useRealBundleForContent(isPlaceholderData, bundleReady);
  const contentLoading = isBundleContentLoading({
    isPending: groupPending,
    isPlaceholderData,
    bundleReady,
  });

  const navCtxEnabled =
    pathnameUsesDashboardNavContext(pathname) && (!hasNavSnapshotCache || bundleReady);
  const { data: navCtx } = useDashboardNavContext(displayUnit, navCtxEnabled);
  const overviewPoints = navCtx?.overviewPoints ?? [];

  const accounts =
    useRealBundle && data ? data.accounts : (shapeAccounts ?? shell?.accounts ?? []);

  const accountsTreeRoot = useMemo(
    () => (navMatchNode ? enrichNavTreeWithAllAccounts(navMatchNode, accounts) : null),
    [navMatchNode, accounts]
  );

  useEffect(() => {
    if (!bundleReady || !data || !navMatchNode || !navCtx || !portfolioGroup) return;
    const firstChartDate = data.ts.accounts_in_group?.points[0]?.as_of_date;
    const nextShell = extractGroupPageShellFromReal(
      data.accounts,
      navCtx.accounts,
      navMatchNode,
      typeof firstChartDate === "string" ? firstChartDate : undefined
    );
    writeGroupPageShellCache(portfolioGroup, displayUnit, nextShell);
    queryClient.setQueryData(queryKeys.groupPageShell(portfolioGroup, displayUnit), nextShell);
  }, [bundleReady, data, navCtx, navMatchNode, portfolioGroup, displayUnit, queryClient]);

  const dashForStrip = useMemo(() => {
    if (!navMatchNode || !navSnapshot) return null;
    const accountsForDash = useRealBundle && navCtx ? navCtx.accounts : navSnapshot.accounts;
    return dashPickForNavStrip(
      {
        accounts: accountsForDash,
        liabilities_breakdown:
          navCtx?.liabilities_breakdown ?? navSnapshot.liabilities_breakdown,
        dashboard_layout: navCtx?.dashboard_layout ?? navSnapshot.dashboard_layout,
        nw_bucket_totals: navCtx?.nw_bucket_totals ?? navSnapshot.nw_bucket_totals,
        card_metrics_by_slug: navCtx?.card_metrics_by_slug ?? navSnapshot.card_metrics_by_slug,
        overviewPoints,
      },
      sidebarNav?.net_worth
    );
  }, [navMatchNode, useRealBundle, navCtx, navSnapshot, overviewPoints, sidebarNav?.net_worth]);

  // Keep the previous unit's charts on screen (FX-converted) during a CLP↔USD switch instead of
  // blinking to the flat-zero placeholder; snaps to exact when the real bundle resolves.
  const keepPrevBundle = useMemo(() => {
    if (!isPlaceholderData || !bundleReady || !data) return null;
    if (data.ts.unit === (displayUnit === "usd" ? "usd" : "clp")) return data;
    const rate = resolveClpPerUsdForKeepPrev(undefined, readFxLatestCache());
    if (rate == null) return null;
    return convertPortfolioGroupBundleUnit(data, displayUnit, rate);
  }, [isPlaceholderData, bundleReady, data, displayUnit]);

  const resolved = useRealBundle && data ? data : (keepPrevBundle ?? placeholderBundle);

  const tableAccounts = useMemo(
    () => accounts,
    [accounts]
  );

  const tableAccountsForPerf = useMemo(
    () =>
      tableAccounts.map((a) => ({
        id: a.source_account_id ?? a.id,
        name: a.name,
        category_slug: a.category_slug ?? a.bucket_slug ?? "",
      })),
    [tableAccounts]
  );

  const ts = resolved.ts;
  const groupPerfRaw = resolved.groupPerf;

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode, ts) : null),
    [navMatchNode, ts]
  );

  const groupedToggleOn = chartCtx?.showGroupedToggle ? chartsGrouped : false;

  const displayValuationBlock = useMemo(() => {
    if (!ts?.accounts_in_group || !chartCtx) return null;
    return buildDisplayValuationBlock(ts, chartCtx, groupedToggleOn);
  }, [ts, chartCtx, groupedToggleOn]);

  const displayPieSlices = useMemo(() => {
    if (!ts?.group_allocation_pie || !chartCtx) return [];
    return buildDisplayPieSlices(ts, chartCtx, groupedToggleOn);
  }, [ts, chartCtx, groupedToggleOn]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx) return groupPerfRaw;
    return buildDisplayGroupPerf(groupPerfRaw, chartCtx, groupedToggleOn);
  }, [groupPerfRaw, chartCtx, groupedToggleOn]);

  const chartSeriesCount = accounts.length;
  const chartColorSlug = (chartCtx?.chartColorSlug ?? portfolioGroup) as AssetGroupSlug | "crypto";
  const pieAllocationSlug = (chartCtx?.pieAllocationSlug ?? portfolioGroup) as AssetGroupSlug;

  const charts = usePortfolioGroupCharts({
    displayValuationBlock,
    displayGroupPerf,
    isYearly,
    chartColorSlug,
    pieAllocationSlug,
    colorPlanGroupSlug: chartCtx?.colorPlanGroupSlug ?? "inversiones",
    groupColorRgb: navMatchNode?.color_rgb,
    navGroupSlug: navMatchNode?.slug,
  });

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const pageColorTarget = navMatchNode ? navColorTargetFromDto(navMatchNode) : undefined;
  const showUsd = displayUnit === "usd";
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (navStillLoading) {
    return (
      <main>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  if (!navMatchNode || !portfolioGroup) {
    return (
      <main>
        <p className="error">{t("groupPage.notFound")}</p>
      </main>
    );
  }

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  if (isPageShapeLoading(accountsShapePending, shapeAccounts, navSnapshotPending, navSnapshot)) {
    return null;
  }

  const isRealEstate = navMatchNode.asset_group_slug === "real_estate";

  return (
    <GroupInfoBase
      title={title}
      colorRgb={navMatchNode.color_rgb}
      colorTarget={pageColorTarget}
      loading={contentLoading}
      portfolio={
        dashForStrip
          ? {
            navNode: navMatchNode,
            groupSlug: portfolioGroup,
            dash: dashForStrip,
            overviewPoints,
            metricsPeriod,
            showUsd,
            animated: true,
          }
          : null
      }
      notice={
        isRealEstate ? (
          <p className="muted" style={{ marginTop: "0.75rem", maxWidth: "52rem", lineHeight: 1.45 }}>
            <Trans
              i18nKey="realEstate.mortgageImportNotice"
              components={{
                1: <strong />,
                3: <span className="mono" />,
                5: <strong />,
                7: <strong />,
                9: <strong />,
                11: <strong />,
                13: <strong />,
                15: <strong />,
                17: <strong />,
              }}
            />
          </p>
        ) : null
      }
      charts={
        <PortfolioGroupChartsSection
          accountsEmpty={accounts.length === 0}
          accountsEmptyMessage={t("groupPage.accountsTreeEmpty")}
          chartSeriesCount={chartSeriesCount}
          valuationBlockForChart={charts.valuationBlockForChart}
          displayPieSlices={displayPieSlices}
          displayUnit={displayUnit}
          xAxisGranularity={xAxisGranularity}
          chartColorSlug={charts.chartColorSlug}
          pieAllocationSlug={charts.pieAllocationSlug}
          colorPlanGroupSlug={charts.colorPlanGroupSlug}
          groupColorMaps={charts.groupColorMaps}
          groupPerfForChart={charts.groupPerfForChart}
          groupPerfBarSeries={charts.groupPerfBarSeries}
          groupTotalStroke={charts.groupTotalStroke}
          groupColorRgb={navMatchNode.color_rgb}
          chartCtx={chartCtx}
          showValuationDeposits={showValuationDeposits}
          chartControls={
            chartCtx?.showGroupedToggle ? (
              <GroupChartViewToggles
                grouped={groupedToggleOn}
                onGroupedChange={setChartsGrouped}
                accumulatedDeposits={showValuationDeposits}
                onAccumulatedDepositsChange={setShowValuationDeposits}
              />
            ) : undefined
          }
        />
      }
      tableAccounts={tableAccountsForPerf}
      accountsTree={
        accountsTreeRoot ? (
          <NavAccountsTree root={accountsTreeRoot} titleI18nKey="groupPage.accountsTreeTitle" />
        ) : null
      }
      exportSlot={<ExportToolbarButton exportPath={`/api/groups/${portfolioGroup}/export.xlsx`} />}
    />
  );
}
