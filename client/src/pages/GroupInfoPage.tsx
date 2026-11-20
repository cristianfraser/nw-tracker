import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { ExportToolbarButton } from "../components/export/ExportModal";
import { GroupChartViewToggles } from "../components/group/GroupChartViewToggles";
import {
  EMPTY_VALUATION_BLOCK,
  GroupPlCombo,
  GroupValuationChart,
  PortfolioGroupChartsSection,
} from "../components/charts/PortfolioGroupChartsSection";
import { groupPerfAbsent } from "../components/charts/groupPerfAbsent";
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
import { BasketGroupPage } from "./BasketGroupPage";
import { InvestmentGroupPage } from "./InvestmentGroupPage";
import { ProportionalAreaChart, StackedValueAreaChart } from "../components/charts/lazyCharts";
import { chartStrokeFromRgbTriplet, groupTabPieSliceFill } from "../chartColors";
import { GROUP_TAB_VAL_TOTAL } from "../groupTabAggregation";
import { rollupTimeseriesBlockYearEnd } from "../dashboardTimeseriesYearly";
import { useSurfacePercentMode } from "../surfaceDisplayPrefs";
import type { GroupGlanceRowDto, TimeseriesAccountLine, TimeseriesBlock } from "../types";
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
  // Null until the page's group is known: defaults, nothing stored.
  const surfaceId = (key: string) => (portfolioGroup ? `group.${portfolioGroup}.${key}` : null);
  const valuationPrefs = useSurfacePrefs(surfaceId("valuation"), "day", "3y");
  const perfPrefs = useSurfacePrefs(surfaceId("combos"), "month", "3y");
  const proportionalPrefs = useSurfacePrefs(surfaceId("proportional"), "month", "total");
  const compositionView = useSurfaceCompositionView(surfaceId("proportional"));
  const positionsPercent = useSurfacePercentMode(surfaceId("positions"));
  // An investment group page (decided on the server, known from the nav tree before any payload):
  // its own layout (InvestmentGroupPage), always the value map, no Agrupado toggle.
  const investmentPage = Boolean(navMatchNode?.investment_glance && !navMatchNode.basket);
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
    stripUnit,
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
    () => valueMapRootForPage(navCtx?.value_map, portfolioGroup),
    [navCtx?.value_map, portfolioGroup]
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
  // A group whose nav node states no member accounts has no daily series to ask for (the route
  // answers 404 «no accounts for group»): nothing is requested.
  const groupHasNoAccounts = navMatchNode?.member_account_ids?.length === 0;
  const dailyGroup = groupHasNoAccounts ? "" : portfolioGroup;
  const dailySeries = useDailySeries(
    { portfolioGroup: dailyGroup || undefined },
    displayUnit,
    timeRangeToDays(valuationPrefs.range),
    valuationIsDaily && dailyGroup !== ""
  );
  const perfDailySeries = useDailySeries(
    { portfolioGroup: dailyGroup || undefined },
    displayUnit,
    timeRangeToDays(perfPrefs.range),
    perfIsDaily && dailyGroup !== "",
    { perfLevels: true }
  );
  const proportionalDailySeries = useDailySeries(
    { portfolioGroup: dailyGroup || undefined },
    displayUnit,
    timeRangeToDays(proportionalPrefs.range),
    proportionalIsDaily && !valueMapShown && !investmentPage && dailyGroup !== ""
  );
  const valuationDailyPending = dailyPayloadPending(valuationIsDaily && !groupHasNoAccounts, dailySeries);
  const perfDailyPending = dailyPayloadPending(perfIsDaily && !groupHasNoAccounts, perfDailySeries);
  const proportionalDailyPending = dailyPayloadPending(proportionalIsDaily && !groupHasNoAccounts, proportionalDailySeries);
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

  // «Valor por posición» (investment pages): the grouped block's child lines stacked, at the
  // pair's period (the P/L combo's surface). Day: the perf daily payload's bucket lines mapped onto
  // the monthly grouped block's metadata, as the valuation chart does.
  const positionsBlock = useMemo((): TimeseriesBlock | null => {
    if (!investmentPage) return null;
    if (perfIsDaily) {
      if (perfDailyPending) return null;
      const daily = perfDailySeries.data;
      if (!daily) return null;
      const bucketBlock = ts?.nav_grouped_blocks?.grouped;
      if (daily.grouped_accounts?.length && bucketBlock) {
        return buildDailyValuationBlock({ ...daily, accounts: daily.grouped_accounts }, bucketBlock);
      }
      return buildDailyValuationBlock(daily, ts?.accounts_in_group ?? null);
    }
    if (!displayValuationBlock) return null;
    return perfPrefs.period === "year" ? rollupTimeseriesBlockYearEnd(displayValuationBlock) : displayValuationBlock;
  }, [
    investmentPage,
    perfIsDaily,
    perfDailyPending,
    perfDailySeries.data,
    ts?.nav_grouped_blocks,
    ts?.accounts_in_group,
    displayValuationBlock,
    perfPrefs.period,
  ]);
  const positionsProportional = useMemo(() => {
    if (!investmentPage) return null;
    if (!perfIsDaily) return displayProportional;
    if (perfDailyPending) return null;
    const daily = perfDailySeries.data;
    if (!daily) return null;
    if (daily.grouped_proportional?.series.length) return daily.grouped_proportional;
    return daily.proportional ?? null;
  }, [investmentPage, perfIsDaily, perfDailyPending, perfDailySeries.data, displayProportional]);

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

  const portfolio =
    navMatchNode && dashForStrip
      ? {
        navNode: navMatchNode,
        groupSlug: portfolioGroup,
        dash: dashForStrip,
        unit: stripUnit,
        // Dimmed until the strip's own live figures land, whatever the rest of the page is doing.
        placeholderPhase: stripIsPlaceholder || navCtx == null,
        linkedCardNavChildren,
      }
      : null;
  const exportSlot = <ExportToolbarButton exportPath={`/api/groups/${portfolioGroup}/export.xlsx`} />;

  // A basket group (declared on the group, known from the nav tree before any payload): the
  // position page's layout, with the same charts and tables. The rail reads the nav context's
  // `basket_glance` (this page's own nav-context request, keyed on the unit).
  if (navMatchNode?.basket) {
    const perfGranularity = perfIsDaily ? "day" : perfPrefs.period === "year" ? "year" : "month";
    const perfPoints = perfIsDaily ? (dailyGroupPerfPoints ?? []) : (charts.groupPerfForChart?.points ?? []);
    const plAbsent = groupPerfAbsent({
      loading: contentLoading,
      barSeriesCount: charts.groupPerfBarSeries.length,
      granularity: perfGranularity,
      pointsCount: perfPoints.length,
    });
    return (
      <BasketGroupPage
        title={title}
        groupSlug={portfolioGroup}
        glance={navCtx?.basket_glance ?? undefined}
        glanceLoading={valueMapLoading || navCtx?.basket_glance == null}
        pendingMembers={navMatchNode.member_account_ids?.length ?? 0}
        loading={contentLoading}
        portfolio={portfolio}
        tableAccounts={tableAccountsForPerf}
        exportSlot={exportSlot}
        valuationChart={
          <GroupValuationChart
            block={(valuationIsDaily ? dailyValuationBlock : charts.valuationBlockForChart) ?? EMPTY_VALUATION_BLOCK}
            displayUnit={displayUnit}
            xAxisGranularity={valuationIsDaily ? "day" : valuationPrefs.period === "year" ? "year" : "month"}
            timeRange={valuationPrefs.range}
            controls={
              <SurfaceControls
                period={valuationPrefs.period}
                onPeriodChange={valuationPrefs.setPeriod}
                range={valuationPrefs.range}
                onRangeChange={valuationPrefs.setRange}
                compact
              />
            }
            includeAccumulatedLines
            chartColorSlug={charts.chartColorSlug}
            colorPlanGroupSlug={charts.colorPlanGroupSlug}
            chartCtx={chartCtx}
            groupColorRgb={navMatchNode.color_rgb}
            hideLegend
            loading={contentLoading || valuationDailyPending}
          />
        }
        plChart={
          plAbsent ? null : (
            <GroupPlCombo
              title={t("accountDetail.positionGlance.plMonthlyTitle")}
              titleAs="h2"
              points={perfPoints}
              displayUnit={displayUnit}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              controls={
                <SurfaceControls
                  period={perfPrefs.period}
                  onPeriodChange={perfPrefs.setPeriod}
                  range={perfPrefs.range}
                  onRangeChange={perfPrefs.setRange}
                  compact
                />
              }
              barSeries={charts.groupPerfBarSeries}
              groupTotalStroke={charts.groupTotalStroke}
              loading={contentLoading || perfDailyPending}
            />
          )
        }
      />
    );
  }

  // An investment group (at or under «Inversiones», not a basket): the glance layout, with the
  // same charts and tables. The title, strip and table read the nav context's `group_glance`.
  if (investmentPage && navMatchNode) {
    const perfGranularity = perfIsDaily ? "day" : perfPrefs.period === "year" ? "year" : "month";
    const perfPoints = perfIsDaily ? (dailyGroupPerfPoints ?? []) : (charts.groupPerfForChart?.points ?? []);
    const plAbsent = groupPerfAbsent({
      loading: contentLoading,
      barSeriesCount: charts.groupPerfBarSeries.length,
      granularity: perfGranularity,
      pointsCount: perfPoints.length,
    });
    const glance = navCtx?.group_glance ?? undefined;
    const glanceLoading = valueMapLoading || navCtx?.group_glance == null;
    const bandBlock = (valuationIsDaily ? dailyValuationBlock : charts.valuationBlockForChart) ?? EMPTY_VALUATION_BLOCK;
    // The band draws the group's own total and its aportes only (the children are the pair's).
    const bandTotalBlock: TimeseriesBlock = {
      ...bandBlock,
      accounts: (bandBlock.accounts ?? []).filter((a) => a.dataKey === GROUP_TAB_VAL_TOTAL),
    };
    const maps = charts.groupColorMaps;
    const lineColor = (line: TimeseriesAccountLine) =>
      maps.byDataKey.get(line.dataKey) ??
      maps.byAccountId.get(line.account_id) ??
      chartStrokeFromRgbTriplet(line.color_rgb);
    const rowColor = (row: GroupGlanceRowDto) =>
      (row.chart_line_account_id != null ? maps.byAccountId.get(row.chart_line_account_id) : undefined) ??
      chartStrokeFromRgbTriplet(row.color_rgb);
    const pendingLabels = (navMatchNode.children ?? [])
      .filter((c) => c.expense_account_id == null)
      .map((c) => resolveNavTreeLabel(c));
    const percentToggle = (
      <span className="surface-controls surface-controls--compact">
        <span className="surface-controls__set">
          <button
            type="button"
            className={positionsPercent.percent ? "is-on" : undefined}
            aria-pressed={positionsPercent.percent}
            title={t("groupPage.investmentGlance.percentToggleTitle")}
            onClick={() => positionsPercent.setPercent(!positionsPercent.percent)}
          >
            {t("groupPage.investmentGlance.percentToggle")}
          </button>
        </span>
      </span>
    );
    const positionsTitle = t("groupPage.investmentGlance.positionsChartTitle");
    const positionsLoading = contentLoading || perfDailyPending;
    return (
      <InvestmentGroupPage
        title={title}
        glance={glance}
        glanceLoading={glanceLoading}
        pendingLabels={pendingLabels}
        loading={contentLoading}
        portfolio={portfolio}
        tableAccounts={tableAccountsForPerf}
        exportSlot={exportSlot}
        colorForRow={rowColor}
        totalColor={charts.groupTotalStroke}
        valuationChart={
          <GroupValuationChart
            block={bandTotalBlock}
            displayUnit={displayUnit}
            xAxisGranularity={valuationIsDaily ? "day" : valuationPrefs.period === "year" ? "year" : "month"}
            timeRange={valuationPrefs.range}
            controls={
              <SurfaceControls
                period={valuationPrefs.period}
                onPeriodChange={valuationPrefs.setPeriod}
                range={valuationPrefs.range}
                onRangeChange={valuationPrefs.setRange}
                compact
              />
            }
            includeAccumulatedLines
            chartColorSlug={charts.chartColorSlug}
            colorPlanGroupSlug={charts.colorPlanGroupSlug}
            chartCtx={chartCtx}
            groupColorRgb={navMatchNode.color_rgb}
            hideLegend
            loading={contentLoading || valuationDailyPending}
          />
        }
        valueMap={
          <ValueMapPanel
            title=""
            surfaceId={`group.${portfolioGroup}.map`}
            root={heldValueMap.root}
            bounds={heldValueMap.bounds}
            unit={heldValueMap.unit}
            loading={valueMapLoading}
            compact
          />
        }
        pairControls={
          <SurfaceControls
            period={perfPrefs.period}
            onPeriodChange={perfPrefs.setPeriod}
            range={perfPrefs.range}
            onRangeChange={perfPrefs.setRange}
            compact
          />
        }
        positionsChart={
          positionsPercent.percent ? (
            <ProportionalAreaChart
              title={positionsTitle}
              block={positionsProportional}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              controls={percentToggle}
              loading={positionsLoading}
              hideLegend
              colorFor={(line) =>
                groupTabPieSliceFill(
                  charts.chartColorSlug,
                  maps,
                  line.account_id ?? Number(line.dataKey),
                  { allocationBucketSlug: charts.pieAllocationSlug }
                )
              }
            />
          ) : (
            <StackedValueAreaChart
              title={positionsTitle}
              block={positionsBlock}
              displayUnit={displayUnit}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              controls={percentToggle}
              loading={positionsLoading}
              colorFor={lineColor}
            />
          )
        }
        plChart={
          plAbsent ? null : (
            <GroupPlCombo
              title={t("accountDetail.positionGlance.plMonthlyTitle")}
              titleAs="h2"
              points={perfPoints}
              displayUnit={displayUnit}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              barSeries={charts.groupPerfBarSeries}
              groupTotalStroke={charts.groupTotalStroke}
              hideLegend
              loading={contentLoading || perfDailyPending}
            />
          )
        }
      />
    );
  }

  return (
    <GroupInfoBase
      title={title}
      loading={contentLoading}
      portfolio={portfolio}
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
      exportSlot={exportSlot}
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
