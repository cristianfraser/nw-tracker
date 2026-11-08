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
  buildDisplayProportional,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import type { AssetGroupSlug } from "../types";
import {
  findBestNavNodeForPathname,
  resolveGroupPageApiParams,
  resolveLinkedCardNavChildren,
} from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import { GROUP_COLD_STRIP } from "../coldPageShape";
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { useTranslation } from "../i18n";
import { dailyPayloadPending, queryShowsLoading } from "../queries/pageShapeReady";
import { useDailySeries, useSidebarNav } from "../queries/hooks";
import { buildDailyValuationBlock } from "../dailySeriesChart";
import { servedDailyPerfComboPoints } from "../servedDailyPerfCombo";
import { timeRangeToDays } from "../timeRange";
import { useSurfaceCompositionView, useSurfacePrefs } from "../surfaceDisplayPrefs";
import { useHeldValueMap, ValueMapPanel, valueMapRootForPage } from "../components/charts/ValueMapPanel";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { useMarkUsagePageNotFound } from "../usagePageTiming";
import { usePortfolioPageData } from "./usePortfolioPageData";
/** Portfolio / asset-class group page: shared shell via {@link GroupInfoBase}, group-specific charts. */
export function GroupInfoPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const { displayUnit } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  // «Not found» only once the nav has answered without this route; until then the page renders
  // its shell (empty title, placeholder charts), dimmed.
  const navSettled = !navPending && !navFetching;

  const navMatchNode = useMemo(
    () => findBestNavNodeForPathname(sidebarNav?.main, pathname),
    [sidebarNav, pathname]
  );

  const apiParams = navMatchNode ? resolveGroupPageApiParams(navMatchNode) : null;
  const portfolioGroup = apiParams?.portfolio_group ?? "";

  // Per-surface controls (persisted per group slug): valuation chart + the two P/L combos.
  const valuationPrefs = useSurfacePrefs(
    `group.${portfolioGroup || "pending"}.valuation`,
    "day",
    "3y"
  );
  const perfPrefs = useSurfacePrefs(`group.${portfolioGroup || "pending"}.combos`, "month", "3y");
  const proportionalPrefs = useSurfacePrefs(
    `group.${portfolioGroup || "pending"}.proportional`,
    "month",
    "total"
  );
  const compositionView = useSurfaceCompositionView(
    `group.${portfolioGroup || "pending"}.proportional`
  );
  const valuationIsDaily = valuationPrefs.period === "day";
  const perfIsDaily = perfPrefs.period === "day";
  const proportionalIsDaily = proportionalPrefs.period === "day";

  const linkedCardNavChildren = useMemo(
    () => resolveLinkedCardNavChildren(navMatchNode, sidebarNav?.main),
    [navMatchNode, sidebarNav?.main]
  );

  const page = usePortfolioPageData({
    portfolioGroup,
    navNode: navMatchNode ?? null,
    displayUnit,
    pathname,
    sidebarNav,
    placeholderFirstMonth: (shellFirstMonth, snapshotFirstMonth) => shellFirstMonth ?? snapshotFirstMonth,
    shellKeepsFirstChartDate: true,
  });
  const { error } = page.bundle;
  const { data: navCtx } = page.navCtxQuery;
  const {
    contentLoading,
    stripShowUsd,
    accounts,
    accountsTreeRoot,
    stripIsPlaceholder,
    dashForStrip,
    resolved,
  } = page;

  const [chartsGrouped, setChartsGrouped] = useState(true);
  const [showValuationDeposits, setShowValuationDeposits] = useState(true);

  useEffect(() => {
    setChartsGrouped(true);
  }, [pathname]);

  // The value map replaces the composition chart when this page's node has something to tile
  // (sub-groups or its own accounts); only the real nav-context payload carries it (a cached
  // snapshot's values are placeholders).
  const valueMapRoot = useMemo(
    () => valueMapRootForPage(navCtx?.value_map, portfolioGroup, displayUnit),
    [navCtx?.value_map, portfolioGroup, displayUnit]
  );
  // A page whose nav node has sub-groups or accounts offers the map (a leaf group's tiles are
  // its accounts); the selected view is shown whatever is loading, holding the last data it
  // drew (old unit).
  const valueMapEligible = Boolean(navMatchNode?.children?.some((c) => c.expense_account_id == null));
  const heldValueMap = useHeldValueMap(
    portfolioGroup,
    valueMapRoot,
    navCtx?.value_map_color_bounds,
    displayUnit
  );
  const valueMapShown = valueMapEligible && compositionView.view === "map";
  // The map comes from nav-context, not the bundle: dim while that payload is not this unit's yet.
  const valueMapLoading = queryShowsLoading(page.navCtxQuery);


  const tableAccounts = useMemo(
    () => accounts,
    [accounts]
  );

  const tableAccountsForPerf = useMemo(
    () =>
      tableAccounts.map((a) => ({
        id: a.id,
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

  // Day view: per-session lines fetched lazily; series identities/colors reuse the
  // matching monthly block (grouped/ungrouped bucket lines share its synthetic ids).
  const dailySeries = useDailySeries(
    { portfolioGroup: portfolioGroup || undefined },
    displayUnit,
    timeRangeToDays(valuationPrefs.range),
    valuationIsDaily && portfolioGroup !== ""
  );
  const perfDailySeries = useDailySeries(
    { portfolioGroup: portfolioGroup || undefined },
    displayUnit,
    timeRangeToDays(perfPrefs.range),
    perfIsDaily && portfolioGroup !== "",
    { perfLevels: true }
  );
  const proportionalDailySeries = useDailySeries(
    { portfolioGroup: portfolioGroup || undefined },
    displayUnit,
    timeRangeToDays(proportionalPrefs.range),
    proportionalIsDaily && !valueMapShown && portfolioGroup !== ""
  );
  const valuationDailyPending = dailyPayloadPending(valuationIsDaily, dailySeries);
  const perfDailyPending = dailyPayloadPending(perfIsDaily, perfDailySeries);
  const proportionalDailyPending = dailyPayloadPending(proportionalIsDaily, proportionalDailySeries);
  const dailyProportionalBlock = useMemo(() => {
    if (!proportionalIsDaily || proportionalDailyPending) return null;
    const daily = proportionalDailySeries.data;
    if (!daily) return null;
    // Composition is always the page's direct children (the grouped buckets), whatever the
    // Agrupado toggle says; leaf pages carry no bucket block and fall back to their accounts.
    if (daily.grouped_proportional?.series.length) return daily.grouped_proportional;
    return daily.proportional ?? null;
  }, [proportionalIsDaily, proportionalDailyPending, proportionalDailySeries.data]);
  const dailyValuationBlock = useMemo(() => {
    if (!valuationIsDaily || valuationDailyPending) return null;
    const daily = dailySeries.data;
    if (!daily) return null;
    // Bucket lines share synthetic ids with the matching monthly grouped block, so the
    // same builder maps them onto that block's series metadata (names/colors/dep keys).
    // `ungrouped_accounts` is only emitted when it differs from `grouped_accounts` —
    // absence with a grouped payload present means both plans resolve to the same buckets.
    const bucketLines = groupedToggleOn
      ? daily.grouped_accounts
      : daily.ungrouped_accounts ?? daily.grouped_accounts;
    const bucketBlock = ts?.nav_grouped_blocks?.[groupedToggleOn ? "grouped" : "ungrouped"];
    if (bucketLines?.length && bucketBlock) {
      return buildDailyValuationBlock({ ...daily, accounts: bucketLines }, bucketBlock);
    }
    return buildDailyValuationBlock(daily, ts?.accounts_in_group ?? null);
  }, [valuationIsDaily, valuationDailyPending, dailySeries.data, groupedToggleOn, ts?.nav_grouped_blocks, ts?.accounts_in_group]);

  const displayProportional = useMemo(() => {
    if (!ts?.group_allocation_proportional || !chartCtx) return null;
    return buildDisplayProportional(ts, chartCtx);
  }, [ts, chartCtx]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx) return groupPerfRaw;
    return buildDisplayGroupPerf(groupPerfRaw, chartCtx, groupedToggleOn);
  }, [groupPerfRaw, chartCtx, groupedToggleOn]);

  // Day view: per-day P/L bars keyed by the monthly block's bar metadata; the total and the
  // cumulative areas are the server's (anchored on the group consolidation).
  const dailyGroupPerfPoints = useMemo(() => {
    if (!perfIsDaily || perfDailyPending) return null;
    const daily = perfDailySeries.data;
    if (!daily || !displayGroupPerf?.bar_accounts.length) return null;
    // Same absence-means-identical rule as the valuation block above; the bucket lines'
    // synthetic ids match the mode's monthly bar metadata (`nav_grouped_bars`).
    const bucketLines = groupedToggleOn
      ? daily.grouped_accounts
      : daily.ungrouped_accounts ?? daily.grouped_accounts;
    const lines = bucketLines?.length ? bucketLines : daily.accounts;
    if (!lines?.length) return null;
    return servedDailyPerfComboPoints({
      series: daily,
      lines,
      barAccounts: displayGroupPerf.bar_accounts,
    });
  }, [perfIsDaily, perfDailyPending, perfDailySeries.data, displayGroupPerf, groupedToggleOn]);

  const chartSeriesCount = accounts.length;
  const chartColorSlug = (chartCtx?.chartColorSlug ?? portfolioGroup) as AssetGroupSlug | "crypto";
  const pieAllocationSlug = (chartCtx?.pieAllocationSlug ?? portfolioGroup) as AssetGroupSlug;

  const charts = usePortfolioGroupCharts({
    displayValuationBlock,
    displayGroupPerf,
    valuationIsYearly: valuationPrefs.period === "year",
    perfYearlyRange: perfPrefs.period === "year" ? perfPrefs.range : null,
    chartColorSlug,
    pieAllocationSlug,
    colorPlanGroupSlug: chartCtx?.colorPlanGroupSlug ?? "inversiones",
    groupColorRgb: navMatchNode?.color_rgb,
    navGroupSlug: navMatchNode?.slug,
  });

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (navSettled && (!navMatchNode || !portfolioGroup)) {
    return <GroupNotFound />;
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
      loading={contentLoading}
      portfolio={
        navMatchNode && dashForStrip
          ? {
            navNode: navMatchNode,
            groupSlug: portfolioGroup,
            dash: dashForStrip,
            showUsd: stripShowUsd,
            // Dimmed until the strip's own live figures land, whatever the rest of the page is doing.
            placeholderPhase: stripIsPlaceholder || navCtx == null,
            linkedCardNavChildren,
          }
          : null
      }
      coldStripShape={GROUP_COLD_STRIP}
      charts={
        <PortfolioGroupChartsSection
          loading={contentLoading}
          valuationLoading={contentLoading || valuationDailyPending}
          proportionalLoading={contentLoading || proportionalDailyPending}
          perfLoading={contentLoading || perfDailyPending}
          accountsEmpty={accounts.length === 0}
          accountsEmptyMessage={t("groupPage.accountsTreeEmpty")}
          chartSeriesCount={chartSeriesCount}
          valuationBlockForChart={
            valuationIsDaily ? dailyValuationBlock : charts.valuationBlockForChart
          }
          proportionalBlock={proportionalIsDaily ? dailyProportionalBlock : displayProportional}
          proportionalXAxisGranularity={
            proportionalIsDaily ? "day" : proportionalPrefs.period === "year" ? "year" : "month"
          }
          proportionalTimeRange={proportionalPrefs.range}
          proportionalReplacement={
            valueMapShown ? (
              <ValueMapPanel
                title={t("charts.currentValueByAccount")}
                surfaceId={`group.${portfolioGroup}.map`}
                view={compositionView.view}
                onViewChange={compositionView.setView}
                root={heldValueMap.root}
                bounds={heldValueMap.bounds}
                unit={heldValueMap.unit}
                loading={valueMapLoading}
              />
            ) : undefined
          }
          proportionalControls={
            <SurfaceControls
              view={valueMapEligible ? compositionView.view : undefined}
              onViewChange={valueMapEligible ? compositionView.setView : undefined}
              period={proportionalPrefs.period}
              onPeriodChange={proportionalPrefs.setPeriod}
              range={proportionalPrefs.range}
              onRangeChange={proportionalPrefs.setRange}
            />
          }
          displayUnit={displayUnit}
          xAxisGranularity={valuationPrefs.period === "year" ? "year" : "month"}
          valuationXAxisGranularity={
            valuationIsDaily ? "day" : valuationPrefs.period === "year" ? "year" : "month"
          }
          valuationTimeRange={valuationPrefs.range}
          perfTimeRange={perfPrefs.range}
          valuationControls={
            <SurfaceControls
              period={valuationPrefs.period}
              onPeriodChange={valuationPrefs.setPeriod}
              range={valuationPrefs.range}
              onRangeChange={valuationPrefs.setRange}
            />
          }
          perfControls={
            <SurfaceControls
              period={perfPrefs.period}
              onPeriodChange={perfPrefs.setPeriod}
              range={perfPrefs.range}
              onRangeChange={perfPrefs.setRange}
            />
          }
          chartColorSlug={charts.chartColorSlug}
          pieAllocationSlug={charts.pieAllocationSlug}
          colorPlanGroupSlug={charts.colorPlanGroupSlug}
          groupColorMaps={charts.groupColorMaps}
          groupPerfForChart={
            perfIsDaily ? { points: dailyGroupPerfPoints ?? [] } : charts.groupPerfForChart
          }
          groupPerfBarSeries={charts.groupPerfBarSeries}
          perfXAxisGranularity={
            perfIsDaily ? "day" : perfPrefs.period === "year" ? "year" : "month"
          }
          groupTotalStroke={charts.groupTotalStroke}
          groupColorRgb={navMatchNode?.color_rgb}
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

/** An unknown group slug: says so, and counts the view under `/404` in the usage log. */
function GroupNotFound() {
  const { t } = useTranslation();
  useMarkUsagePageNotFound();
  return (
    <main>
      <p className="error">{t("groupPage.notFound")}</p>
    </main>
  );
}
