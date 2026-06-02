import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { PortfolioGroupChartsSection } from "../components/charts/PortfolioGroupChartsSection";
import { filterTimeseriesBlockByAccountIds } from "../filterTimeseriesBlock";
import { filterGroupPerfByAccountIds } from "../filterGroupPerfByAccountIds";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayPieSlices,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import { liabilitiesChartBucketNavNodes } from "../liabilitiesChartBuckets";
import { parseLiabilitiesSubgroupParam } from "../liabilitiesPath";
import { navAccountIdSet } from "../portfolioNavDashboardCards";
import { findLiabilitiesNavNodeForPathname } from "../portfolioNavFromApi";
import { navColorTargetFromDto, resolveNavTreeLabel } from "../sidebarNavFromApi";
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { useTranslation } from "../i18n";
import { pathnameUsesDashboardNavContext } from "../dashboardNavContextRoutes";
import { prefetchPortfolioGroupBundle } from "../queries/displayUnitQueries";
import { buildPlaceholderPortfolioGroupBundle } from "../placeholders/groupPagePlaceholders";
import { dashPickForNavStrip } from "../queries/fetchers";
import {
  useDashboardNavContext,
  usePortfolioGroupBundle,
  useSidebarNav,
} from "../queries/hooks";

/** Pasivos root and subgroups (`/liabilities`, `/liabilities/credit-card`, `/liabilities/mortgage`). */
export function LiabilitiesGroupPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { subgroup: liabilitiesSubgroupParam } = useParams();
  const categoryFilter = useMemo(
    () => parseLiabilitiesSubgroupParam(liabilitiesSubgroupParam),
    [liabilitiesSubgroupParam]
  );

  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav();
  const navStillLoading = (navPending || navFetching) && sidebarNav == null;
  const { data: navCtx } = useDashboardNavContext(
    displayUnit,
    pathnameUsesDashboardNavContext(pathname)
  );
  const dash = navCtx ? dashPickForNavStrip(navCtx, sidebarNav?.net_worth) : null;
  const overviewPoints = navCtx?.overviewPoints ?? [];

  const navMatchNode = useMemo(
    () =>
      findLiabilitiesNavNodeForPathname(
        sidebarNav?.main,
        pathname,
        categoryFilter ?? undefined
      ),
    [sidebarNav, pathname, categoryFilter]
  );

  const queryClient = useQueryClient();
  const portfolioGroup =
    navMatchNode?.slug ??
    (categoryFilter === "credit_card"
      ? "liabilities_credit_card"
      : categoryFilter === "mortgage"
        ? "liabilities_mortgage"
        : "liabilities");
  const { data, error, isPending: groupPending } = usePortfolioGroupBundle({
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
    () => buildPlaceholderPortfolioGroupBundle(displayUnit),
    [displayUnit]
  );
  const bundleReady = Boolean(data?.ts?.accounts_in_group && data.ts.group_allocation_pie);
  const contentLoading = groupPending || !bundleReady;
  const resolved = bundleReady && data ? data : placeholderBundle;

  const accounts = resolved.accounts;

  const chartAccountIds = useMemo(
    () => (navMatchNode ? navAccountIdSet(navMatchNode) : new Set<number>()),
    [navMatchNode]
  );

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
    let block = buildDisplayValuationBlock(ts, accounts, chartCtx, false, navMatchNode);
    if (!block) return null;
    if (!chartCtx.liabilitiesGrouped) {
      block = filterTimeseriesBlockByAccountIds(block, chartAccountIds);
    }
    return block;
  }, [ts, accounts, chartCtx, chartAccountIds, navMatchNode]);

  const displayPieSlices = useMemo(() => {
    if (!ts?.group_allocation_pie || !chartCtx || !navMatchNode) return [];
    return buildDisplayPieSlices(ts, accounts, chartCtx, false, navMatchNode);
  }, [ts, accounts, chartCtx, navMatchNode]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx || !navMatchNode) return groupPerfRaw;
    const perf = buildDisplayGroupPerf(groupPerfRaw, accounts, chartCtx, false, navMatchNode);
    if (!chartCtx.liabilitiesGrouped) {
      return filterGroupPerfByAccountIds(perf, chartAccountIds);
    }
    return perf;
  }, [groupPerfRaw, accounts, chartCtx, chartAccountIds, navMatchNode]);

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
  const err = error instanceof Error ? error.message : error ? "Failed to load" : null;

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

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  return (
    <GroupInfoBase
      title={title}
      colorRgb={navMatchNode.color_rgb}
      colorTarget={pageColorTarget}
      loading={contentLoading}
      portfolio={
        dash
          ? {
              navNode: navMatchNode,
              groupSlug: "liabilities",
              subgroup: categoryFilter ?? undefined,
              dash,
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
        navMatchNode ? (
          <NavAccountsTree
            root={navMatchNode}
            titleI18nKey="groupPage.accountsTreeTitleLiabilities"
          />
        ) : null
      }
    />
  );
}
