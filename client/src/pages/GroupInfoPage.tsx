import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { ExportToolbarButton } from "../components/export/ExportModal";
import { EMPTY_VALUATION_BLOCK, GroupPlCombo, GroupValuationChart } from "../components/charts/GroupCharts";
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
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { useTranslation } from "../i18n";
import { dailyPayloadPending, queryShowsLoading } from "../queries/pageShapeReady";
import { useHeldDailySeries, useSidebarNav } from "../queries/hooks";
import { buildDailyValuationBlock } from "../dailySeriesChart";
import { servedDailyPerfComboPoints } from "../servedDailyPerfCombo";
import { timeRangeToDays } from "../timeRange";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
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
/**
 * A net-worth group's page (`/inversiones/*`, `/cash_eqs/*`): the basket page for a group declared
 * a basket, else the glance page ({@link InvestmentGroupPage}) — for a group at or under
 * «Inversiones» and, in its cash form, for a group of the cash bucket. The server marks the node
 * (`basket`, `investment_glance`, `cash_glance`); this page builds the charts they share.
 */
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
  const positionsPercent = useSurfacePercentMode(surfaceId("positions"));
  // The glance page in its cash form (decided on the server, known from the nav tree before any
  // payload): a group of the cash bucket. Every other non-basket group here is an investment group.
  const cashPage = Boolean(navMatchNode?.cash_glance && !navMatchNode.basket);
  const glancePage = !navMatchNode?.basket;
  const valuationIsDaily = valuationPrefs.period === "day";
  const perfIsDaily = perfPrefs.period === "day";

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
  const error = page.bundleError;
  const { data: navCtx } = page.navCtxQuery;
  const {
    contentLoading,
    stripUnit,
    accounts,
    stripIsPlaceholder,
    dashForStrip,
    resolved,
  } = page;

  // The value map replaces the composition chart when this page's node has something to tile
  // (sub-groups or its own accounts); only the real nav-context payload carries it (a cached
  // snapshot's values are placeholders).
  const valueMapRoot = useMemo(
    () => valueMapRootForPage(navCtx?.value_map, portfolioGroup),
    [navCtx?.value_map, portfolioGroup]
  );
  // The map is shown whatever is loading, holding the last data it drew (old unit).
  const heldValueMap = useHeldValueMap(
    portfolioGroup,
    valueMapRoot,
    navCtx?.value_map_color_bounds,
    displayUnit
  );
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

  // The page's children are the grouped buckets wherever the payload carries them.
  const groupedToggleOn = Boolean(chartCtx?.showGroupedToggle);

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
  // Each held across a unit or range change (a held daily series is drawn, dimmed, in its unit).
  const dailySeries = useHeldDailySeries(
    { portfolioGroup: dailyGroup || undefined },
    displayUnit,
    timeRangeToDays(valuationPrefs.range),
    valuationIsDaily && dailyGroup !== ""
  );
  const perfDailySeries = useHeldDailySeries(
    { portfolioGroup: dailyGroup || undefined },
    displayUnit,
    timeRangeToDays(perfPrefs.range),
    perfIsDaily && dailyGroup !== "",
    { perfLevels: true }
  );
  const valuationDailyPending = dailyPayloadPending(valuationIsDaily && !groupHasNoAccounts, dailySeries);
  const perfDailyPending = dailyPayloadPending(perfIsDaily && !groupHasNoAccounts, perfDailySeries);
  const valuationDailyLoading = valuationIsDaily && !groupHasNoAccounts && dailySeries.loading;
  const perfDailyLoading = perfIsDaily && !groupHasNoAccounts && perfDailySeries.loading;
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

  // «Valor por posición» (a cash page's «Saldo por cuenta»): the grouped block's child lines
  // stacked, at the pair's period (the P/L combo's surface). Day: the perf daily payload's bucket
  // lines mapped onto the monthly grouped block's metadata, as the valuation chart does.
  const positionsBlock = useMemo((): TimeseriesBlock | null => {
    if (!glancePage) return null;
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
    glancePage,
    perfIsDaily,
    perfDailyPending,
    perfDailySeries.data,
    ts?.nav_grouped_blocks,
    ts?.accounts_in_group,
    displayValuationBlock,
    perfPrefs.period,
  ]);
  const positionsProportional = useMemo(() => {
    if (!glancePage) return null;
    if (!perfIsDaily) return displayProportional;
    if (perfDailyPending) return null;
    const daily = perfDailySeries.data;
    if (!daily) return null;
    if (daily.grouped_proportional?.series.length) return daily.grouped_proportional;
    return daily.proportional ?? null;
  }, [glancePage, perfIsDaily, perfDailyPending, perfDailySeries.data, displayProportional]);

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

  // Each chart is formatted in the unit of the payload it draws (a held one keeps its own).
  const valuationUnit = valuationIsDaily ? (dailySeries.data?.unit ?? ts.unit) : ts.unit;
  const perfUnit = perfIsDaily ? (perfDailySeries.data?.unit ?? ts.unit) : (groupPerfRaw?.unit ?? ts.unit);
  const positionsUnit = perfIsDaily ? (perfDailySeries.data?.unit ?? ts.unit) : ts.unit;

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
        placeholderPhase: stripIsPlaceholder,
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
            displayUnit={valuationUnit}
            xAxisGranularity={valuationIsDaily ? "day" : valuationPrefs.period === "year" ? "year" : "month"}
            timeRange={valuationPrefs.range}
            controls={
              <SurfaceControls
                period={valuationPrefs.period}
                onPeriodChange={valuationPrefs.setPeriod}
                range={valuationPrefs.range}
                onRangeChange={valuationPrefs.setRange}
              />
            }
            includeAccumulatedLines
            chartColorSlug={charts.chartColorSlug}
            colorPlanGroupSlug={charts.colorPlanGroupSlug}
            chartCtx={chartCtx}
            groupColorRgb={navMatchNode.color_rgb}
            hideLegend
            loading={contentLoading || valuationDailyLoading}
          />
        }
        plChart={
          plAbsent ? null : (
            <GroupPlCombo
              title={t("accountDetail.positionGlance.plMonthlyTitle")}
              titleAs="h2"
              points={perfPoints}
              displayUnit={perfUnit}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              controls={
                <SurfaceControls
                  period={perfPrefs.period}
                  onPeriodChange={perfPrefs.setPeriod}
                  range={perfPrefs.range}
                  onRangeChange={perfPrefs.setRange}
                />
              }
              barSeries={charts.groupPerfBarSeries}
              groupTotalStroke={charts.groupTotalStroke}
              loading={contentLoading || perfDailyLoading}
            />
          )
        }
      />
    );
  }

  // Every other group of these routes is a glance page; a settled nav node that is neither is a
  // tree the server did not mark, not something to draw another way.
  // (A tree from a server older than `cash_glance` states neither: the page keeps its pending
  // frame until the client reloads onto the deployed build.)
  if (navSettled && navMatchNode && navMatchNode.investment_glance === false && navMatchNode.cash_glance === false) {
    throw new Error(`Group page ${navMatchNode.slug}: neither a basket, an investment group nor a cash group`);
  }

  // An investment group (at or under «Inversiones») or a cash group: the glance layout, with the
  // same charts and tables. The title, strip and table read the nav context's `group_glance`.
  // Before the nav tree is in (a first-ever visit) the page is its pending frame.
  {
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
    const pendingLabels = (navMatchNode?.children ?? [])
      .filter((c) => c.expense_account_id == null)
      .map((c) => resolveNavTreeLabel(c));
    const percentToggle = (
      <span className="surface-controls">
        <span className="surface-controls__set">
          <button
            type="button"
            className={positionsPercent.percent ? "is-on" : undefined}
            aria-pressed={positionsPercent.percent}
            title={t(
              cashPage ? "groupPage.cashGlance.percentToggleTitle" : "groupPage.investmentGlance.percentToggleTitle"
            )}
            onClick={() => positionsPercent.setPercent(!positionsPercent.percent)}
          >
            {t("groupPage.investmentGlance.percentToggle")}
          </button>
        </span>
      </span>
    );
    const positionsTitle = t(
      cashPage ? "groupPage.cashGlance.balanceByAccount" : "groupPage.investmentGlance.positionsChartTitle"
    );
    const positionsLoading = contentLoading || perfDailyLoading;
    return (
      <InvestmentGroupPage
        cash={cashPage}
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
            title={cashPage ? t("groupPage.cashGlance.balanceTitle") : undefined}
            block={bandTotalBlock}
            displayUnit={valuationUnit}
            xAxisGranularity={valuationIsDaily ? "day" : valuationPrefs.period === "year" ? "year" : "month"}
            timeRange={valuationPrefs.range}
            controls={
              <SurfaceControls
                period={valuationPrefs.period}
                onPeriodChange={valuationPrefs.setPeriod}
                range={valuationPrefs.range}
                onRangeChange={valuationPrefs.setRange}
              />
            }
            includeAccumulatedLines={!cashPage}
            chartColorSlug={charts.chartColorSlug}
            colorPlanGroupSlug={charts.colorPlanGroupSlug}
            chartCtx={chartCtx}
            groupColorRgb={navMatchNode?.color_rgb}
            hideLegend
            loading={contentLoading || valuationDailyLoading}
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
          />
        }
        pairControls={
          <SurfaceControls
            period={perfPrefs.period}
            onPeriodChange={perfPrefs.setPeriod}
            range={perfPrefs.range}
            onRangeChange={perfPrefs.setRange}
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
              displayUnit={positionsUnit}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              controls={percentToggle}
              loading={positionsLoading}
              colorFor={lineColor}
              hideDeposits={cashPage}
            />
          )
        }
        plChart={
          cashPage || plAbsent ? null : (
            <GroupPlCombo
              title={t("accountDetail.positionGlance.plMonthlyTitle")}
              titleAs="h2"
              points={perfPoints}
              displayUnit={perfUnit}
              xAxisGranularity={perfGranularity}
              timeRange={perfPrefs.range}
              barSeries={charts.groupPerfBarSeries}
              groupTotalStroke={charts.groupTotalStroke}
              hideLegend
              loading={contentLoading || perfDailyLoading}
            />
          )
        }
      />
    );
  }
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
