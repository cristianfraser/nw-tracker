import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
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
import { useTranslation } from "../i18n";
import { prefetchPortfolioGroupBundle } from "../queries/displayUnitQueries";
import { extractGroupPageShellFromReal } from "../placeholders/groupPageShellFromNav";
import { buildPlaceholderPortfolioGroupBundle } from "../placeholders/groupPageChartPlaceholders";
import { dashPickForNavStrip } from "../queries/fetchers";
import { writeGroupPageShellCache } from "../queries/groupPageShellCache";
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
  const { data: navCtx } = useDashboardNavContext(
    displayUnit,
    pathnameUsesDashboardNavContext(pathname)
  );
  const overviewPoints = navCtx?.overviewPoints ?? [];

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

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode) : null),
    [navMatchNode]
  );

  const groupedToggleOn = chartCtx?.showGroupedToggle ? chartsGrouped : false;

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

  const accounts =
    useRealBundle && data ? data.accounts : (shapeAccounts ?? shell?.accounts ?? []);

  const accountsTreeRoot = useMemo(
    () => (navMatchNode ? enrichNavTreeWithAllAccounts(navMatchNode, accounts) : null),
    [navMatchNode, accounts]
  );

  useEffect(() => {
    if (!bundleReady || !data || !navMatchNode || !navCtx || !portfolioGroup) return;
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

  const displayValuationBlock = useMemo(() => {
    if (!ts?.accounts_in_group || !chartCtx) return null;
    return buildDisplayValuationBlock(ts, accounts, chartCtx, groupedToggleOn, navMatchNode);
  }, [ts, accounts, chartCtx, groupedToggleOn, navMatchNode]);

  const displayPieSlices = useMemo(() => {
    if (!ts?.group_allocation_pie || !chartCtx) return [];
    return buildDisplayPieSlices(ts, accounts, chartCtx, groupedToggleOn, navMatchNode);
  }, [ts, accounts, chartCtx, groupedToggleOn, navMatchNode]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx) return groupPerfRaw;
    return buildDisplayGroupPerf(groupPerfRaw, accounts, chartCtx, groupedToggleOn, navMatchNode);
  }, [groupPerfRaw, accounts, chartCtx, groupedToggleOn, navMatchNode]);

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
            Hipoteca en UF: exporta la hoja <strong>dividendos</strong> de Numbers a{" "}
            <span className="mono">cfraser/depto-dividendos.csv</span>. El import crea{" "}
            <strong>un movimiento por cada pago real</strong> (misma fecha que en el banco), con CLP, UF del pago, UF/día,
            crédito restante, amortización, interés, escenario <strong>min UF</strong> y totales <strong>valor neto</strong> /{" "}
            <strong>pago acumulado</strong> en la nota. En la ficha de la cuenta inmobiliaria verás la tabla alineada a esa
            hoja. En los gráficos, <strong>aportes acum. en CLP</strong> es la suma de los pesos pagados; en{" "}
            <strong>USD</strong> (si usas esa vista) se suma el equivalente de cada pago al tipo del día del pago (5
            decimales), sin reconvertir el acumulado CLP al tipo de cada mes. Lo mismo para <strong>UF</strong> en APIs que
            pidan unidad UF. Valor vivienda y pasivo siguen desde el Excel a fin de mes.
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
    />
  );
}
