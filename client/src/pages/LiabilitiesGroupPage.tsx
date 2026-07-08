import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { PortfolioGroupChartsSection } from "../components/charts/PortfolioGroupChartsSection";
import { LiabilitiesCreditCardGroupSection } from "../components/liabilities/LiabilitiesCreditCardGroupSection";
import { LiabilitiesMortgageGroupSection } from "../components/liabilities/LiabilitiesMortgageGroupSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayPieSlices,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import { liabilitiesChartBucketNavNodes } from "../liabilitiesChartBuckets";
import { resolveLiabilitiesPageKind } from "../liabilitiesPageKind";
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
  useAccountMonthlyPerformance,
  useAccountsByPortfolioGroup,
  useDashboardNavContext,
  useDashboardNavSnapshot,
  useGroupPageShell,
  usePortfolioGroupBundle,
  usePortfolioGroupCcLedger,
  usePortfolioGroupMortgageLedger,
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

  const pageKind = useMemo(
    () => (navMatchNode ? resolveLiabilitiesPageKind(navMatchNode) : null),
    [navMatchNode]
  );

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

  const ccLedgerSlug =
    pageKind === "pasivos_root" || pageKind === "credit_card" ? portfolioGroup : undefined;
  const mortgageLedgerSlug =
    pageKind === "pasivos_root"
      ? "liabilities"
      : pageKind === "mortgage"
        ? portfolioGroup
        : undefined;

  const { data: ccLedger } = usePortfolioGroupCcLedger(
    ccLedgerSlug,
    {},
    shapeEnabled && ccLedgerSlug != null
  );
  const { data: mortgageLedger } = usePortfolioGroupMortgageLedger(
    mortgageLedgerSlug,
    shapeEnabled && mortgageLedgerSlug != null
  );

  useEffect(() => {
    if (!navMatchNode) return;
    void prefetchPortfolioGroupBundle(queryClient, {
      portfolio_group: portfolioGroup,
      unit: displayUnit,
    });
  }, [queryClient, navMatchNode, portfolioGroup, displayUnit]);

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

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode, accounts) : null),
    [navMatchNode, accounts]
  );

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
        nw_bucket_totals: navCtx?.nw_bucket_totals ?? navSnapshot.nw_bucket_totals,
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
      return liabilitiesChartBucketNavNodes(navMatchNode, accounts).length;
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

  const mortgageAccount = useMemo(() => {
    if (pageKind !== "mortgage" && pageKind !== "pasivos_root") return null;
    return (
      accounts.find((a) => {
        const cat = a.category_slug ?? a.bucket_slug ?? "";
        return cat.includes("mortgage") || cat === "mortgage";
      }) ?? null
    );
  }, [accounts, pageKind]);

  const mortgageOperationalId = useMemo(() => {
    if (mortgageAccount) {
      return String(mortgageAccount.source_account_id ?? mortgageAccount.id);
    }
    if (mortgageLedger?.account_id) return String(mortgageLedger.account_id);
    return undefined;
  }, [mortgageAccount, mortgageLedger?.account_id]);

  const { data: mortgagePerf } = useAccountMonthlyPerformance(mortgageOperationalId, displayUnit);

  const mortgageDashRow = useMemo(() => {
    if (!mortgageOperationalId) return null;
    const id = Number(mortgageOperationalId);
    const rows = navCtx?.accounts ?? navSnapshot?.accounts ?? [];
    return rows.find((a) => a.account_id === id) ?? null;
  }, [mortgageOperationalId, navCtx?.accounts, navSnapshot?.accounts]);

  const mortgageSummary = useMemo(
    () => ({
      account_id: mortgageDashRow?.account_id ?? mortgageLedger?.account_id ?? 0,
      latest_valuation_clp: mortgageDashRow?.current_value_clp ?? null,
    }),
    [mortgageDashRow, mortgageLedger?.account_id]
  );

  const mortgageColorRgb = useMemo(() => {
    if (!mortgageAccount) return navMatchNode?.color_rgb ?? null;
    return (
      ts?.accounts_in_group?.accounts?.find(
        (a) => a.account_id === (mortgageAccount.source_account_id ?? mortgageAccount.id)
      )?.color_rgb ??
      navMatchNode?.color_rgb ??
      null
    );
  }, [mortgageAccount, ts?.accounts_in_group?.accounts, navMatchNode?.color_rgb]);

  const chartsSection = (
    <>
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
        groupColorRgb={navMatchNode?.color_rgb}
        chartCtx={chartCtx}
        hideGroupPerf
      />

      {pageKind === "pasivos_root" && ccLedger ? (
        <LiabilitiesCreditCardGroupSection
          ccLedger={ccLedger}
          displayUnit={displayUnit}
          xAxisGranularity={xAxisGranularity}
          linkTo="/liabilities/credit-card"
        />
      ) : null}

      {pageKind === "pasivos_root" && mortgageLedger ? (
        <LiabilitiesMortgageGroupSection
          mortgageLedger={mortgageLedger}
          displayUnit={displayUnit}
          metricsPeriod={metricsPeriod}
          xAxisGranularity={xAxisGranularity}
          monthlyPerfRows={mortgagePerf?.monthly ?? []}
          summary={mortgageSummary}
          accountDashRow={mortgageDashRow}
          accountColorRgb={mortgageColorRgb}
          linkTo="/liabilities/mortgage"
        />
      ) : null}

      {pageKind === "credit_card" && ccLedger ? (
        <LiabilitiesCreditCardGroupSection
          ccLedger={ccLedger}
          displayUnit={displayUnit}
          xAxisGranularity={xAxisGranularity}
        />
      ) : null}

      {pageKind === "mortgage" && mortgageLedger ? (
        <LiabilitiesMortgageGroupSection
          mortgageLedger={mortgageLedger}
          displayUnit={displayUnit}
          metricsPeriod={metricsPeriod}
          xAxisGranularity={xAxisGranularity}
          monthlyPerfRows={mortgagePerf?.monthly ?? []}
          summary={mortgageSummary}
          accountDashRow={mortgageDashRow}
          accountColorRgb={mortgageColorRgb}
        />
      ) : null}
    </>
  );

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
      hideConsolidatedTables
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
      charts={chartsSection}
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
