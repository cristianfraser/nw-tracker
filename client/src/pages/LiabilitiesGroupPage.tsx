import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { PortfolioGroupChartsSection } from "../components/charts/PortfolioGroupChartsSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayPieSlices,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import { liabilitiesChartBucketNavNodes } from "../liabilitiesChartBuckets";
import { parseLiabilitiesSubgroupParam } from "../liabilitiesPath";
import { findBestNavNodeForPathname, findNavNodeBySlug } from "../portfolioNavFromApi";
import { enrichNavTreeWithAllAccounts } from "../navAccountsTreeEnrich";
import { navColorTargetFromDto, resolveNavTreeLabel } from "../sidebarNavFromApi";
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { useTranslation } from "../i18n";
import { pathnameUsesDashboardNavContext } from "../dashboardNavContextRoutes";
import { prefetchPortfolioGroupBundle } from "../queries/displayUnitQueries";
import { extractGroupPageShellFromReal } from "../placeholders/groupPageShellFromNav";
import { buildPlaceholderPortfolioGroupBundle } from "../placeholders/groupPageChartPlaceholders";
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

/** Pasivos root and subgroups (`/liabilities`, `/liabilities/credit-card`, `/liabilities/mortgage`). */
export function LiabilitiesGroupPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { subgroup: liabilitiesSubgroupParam, issuer: issuerParam } = useParams();
  const categoryFilter = useMemo(
    () => parseLiabilitiesSubgroupParam(liabilitiesSubgroupParam),
    [liabilitiesSubgroupParam]
  );

  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav();
  const navStillLoading = (navPending || navFetching) && sidebarNav == null;
  const hasNavSnapshotCache = hasDashboardNavSnapshotCache(displayUnit);

  const navMatchNode = useMemo(() => {
    const best = findBestNavNodeForPathname(sidebarNav?.main, pathname);
    if (!issuerParam) return best;
    const issuerNode = findNavNodeBySlug(sidebarNav?.main, issuerParam);
    if (issuerNode?.asset_group_slug === "credit_cards") return issuerNode;
    return best;
  }, [sidebarNav, pathname, issuerParam]);

  const queryClient = useQueryClient();
  const portfolioGroup =
    navMatchNode?.slug ??
    (categoryFilter === "credit_card"
      ? "liabilities_credit_card"
      : categoryFilter === "mortgage"
        ? "liabilities_mortgage"
        : "liabilities");
  const shapeEnabled = Boolean(navMatchNode);
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
    enabled: Boolean(navMatchNode),
  });

  useEffect(() => {
    if (!navMatchNode) return;
    void prefetchPortfolioGroupBundle(queryClient, {
      portfolio_group: portfolioGroup,
      unit: displayUnit,
    });
  }, [queryClient, navMatchNode, portfolioGroup, displayUnit]);

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode) : null),
    [navMatchNode]
  );

  const placeholderBundle = useMemo(
    () => buildPlaceholderPortfolioGroupBundle(displayUnit, shell?.accounts ?? [], portfolioGroup),
    [displayUnit, shell?.accounts, portfolioGroup]
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
    if (!bundleReady || !data || !navMatchNode || !navCtx) return;
    const nextShell = extractGroupPageShellFromReal(data.accounts, navCtx.accounts, navMatchNode);
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
        suecia_snapshot: navCtx?.suecia_snapshot ?? navSnapshot.suecia_snapshot,
        nw_bucket_totals: navCtx?.nw_bucket_totals ?? navSnapshot.nw_bucket_totals,
        overviewPoints,
      },
      sidebarNav?.net_worth
    );
  }, [navMatchNode, useRealBundle, navCtx, navSnapshot, overviewPoints, sidebarNav?.net_worth]);

  const resolved = useRealBundle && data ? data : placeholderBundle;

  const tableAccountsForPerf = useMemo(
    () =>
      accounts.map((a) => ({
        id: a.source_account_id ?? a.id,
        name: a.name,
        category_slug: a.category_slug,
      })),
    [accounts]
  );

  const ts = resolved.ts;
  const groupPerfRaw = resolved.groupPerf;

  const displayValuationBlock = useMemo(() => {
    if (!ts?.accounts_in_group || !chartCtx || !navMatchNode) return null;
    return buildDisplayValuationBlock(ts, accounts, chartCtx, false, navMatchNode);
  }, [ts, accounts, chartCtx, navMatchNode]);

  const displayPieSlices = useMemo(() => {
    if (!ts?.group_allocation_pie || !chartCtx || !navMatchNode) return [];
    return buildDisplayPieSlices(ts, accounts, chartCtx, false, navMatchNode);
  }, [ts, accounts, chartCtx, navMatchNode]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx || !navMatchNode) return groupPerfRaw;
    return buildDisplayGroupPerf(groupPerfRaw, accounts, chartCtx, false, navMatchNode);
  }, [groupPerfRaw, accounts, chartCtx, navMatchNode]);

  const chartSeriesCount = useMemo(() => {
    if (chartCtx?.liabilitiesGrouped && navMatchNode) {
      return liabilitiesChartBucketNavNodes(navMatchNode).length;
    }
    return accounts.length;
  }, [chartCtx, navMatchNode, accounts.length]);

  const charts = usePortfolioGroupCharts({
    displayValuationBlock,
    displayGroupPerf,
    isYearly,
    chartColorSlug: "liabilities",
    pieAllocationSlug: "liabilities",
    colorPlanGroupSlug: "inversiones",
    groupColorRgb: navMatchNode?.color_rgb,
    navGroupSlug: navMatchNode?.slug,
  });

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const pageColorTarget = navMatchNode ? navColorTargetFromDto(navMatchNode) : undefined;
  const showUsd = displayUnit === "usd";
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (liabilitiesSubgroupParam != null && liabilitiesSubgroupParam !== "" && categoryFilter === null) {
    return <Navigate to="/liabilities" replace />;
  }

  if (navStillLoading) {
    return (
      <main>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  if (!navMatchNode) {
    return <Navigate to="/" replace />;
  }

  if (
    issuerParam != null &&
    issuerParam !== "" &&
    (navMatchNode.slug !== issuerParam || navMatchNode.asset_group_slug !== "credit_cards")
  ) {
    return <Navigate to="/liabilities" replace />;
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
              subgroup: categoryFilter ?? undefined,
              dash: dashForStrip,
              overviewPoints,
              metricsPeriod,
              showUsd,
              animated: true,
            }
          : null
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
        />
      }
      tableAccounts={tableAccountsForPerf}
      monthlyDetailHint={t("groupPage.monthlyDetailHintLiabilities")}
      flowsHint={t("groupPage.flowsHintLiabilities")}
      accountsTree={
        accountsTreeRoot ? (
          <NavAccountsTree
            root={accountsTreeRoot}
            titleI18nKey="groupPage.accountsTreeTitleLiabilities"
          />
        ) : null
      }
    />
  );
}
