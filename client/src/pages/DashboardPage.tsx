import { useEffect, useMemo, useContext } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MonthlyPerformanceComboChart,
  ProportionalAreaChart,
  LineChartPanel,
} from "../components/charts/lazyCharts";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { UpcomingPaymentsPanel } from "../components/dashboard/UpcomingPaymentsPanel";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { LatestMovementsTable } from "../components/dashboard/LatestMovementsTable";
import { ExportToolbarButton } from "../components/export/ExportModal";
import {
  prefetchAccountsByPortfolioGroup,
  prefetchDashboardBundle,
  prefetchDashboardNavSnapshot,
} from "../queries/displayUnitQueries";
import { dashPickForNavStrip } from "../queries/fetchers";
import { bundleContent, dailyPayloadPending } from "../queries/pageShapeReady";
import { useHeldUnitQuery, useHeldUnitValue, type UnitCandidate } from "../queries/heldUnitPayload";
import { queryKeys } from "../queries/keys";
import {
  nwBucketTotalsFromDashTotals,
  writeDashboardNavSnapshotCache,
} from "../queries/dashboardNavSnapshotCache";
import {
  useAccountsByPortfolioGroup,
  useDashboardBundle,
  useDashboardNavSnapshot,
  useDashboardOverviewDaily,
  useSidebarNav,
} from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { allocationBucketColor } from "../chartColors";
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "../dashboardTimeseriesYearly";
import { useTranslation } from "../i18n";
import { buildGroupPageShellFromNav } from "../placeholders/groupPageShellFromNav";
import {
  buildPlaceholderDashboardBundle,
  buildPlaceholderNavStripDash,
  chartShapeFromLoadedDashboardBundle,
} from "../placeholders/dashboardPagePlaceholders";
import { enrichNavTreeWithAllAccounts, netWorthTreeWithLiabilitiesSubtree } from "../navAccountsTreeEnrich";
import { DASHBOARD_COLD_STRIP } from "../coldPageShape";
import { netWorthTableAccountsFromDash } from "../portfolioDashboardBuckets";
import { clipMonthsThenRollup, timeRangeToDays } from "../timeRange";
import {
  LONG_RANGE_OPTIONS,
  monthYearSurfacePeriod,
  longSurfaceRange,
  useSurfaceAreaMode,
  useSurfaceCompositionView,
  useSurfacePercentMode,
  useSurfacePrefs,
} from "../surfaceDisplayPrefs";
import { useHeldValueMap, ValueMapPanel, valueMapRootForPage } from "../components/charts/ValueMapPanel";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { DashboardFlowsChart, DashboardFlowsPeriods } from "../components/dashboard/DashboardFlowsSummary";
import { PageGridTile } from "../components/layout/PageGridTile";
import {
  DashboardPreviewShownContext,
  DashboardStripReadyContext,
  useDashboardAboutPreview,
  useDashboardFold,
} from "../dashboardFold";
import { dashboardAllocationStackSpans, dashboardTileSmallSpan, dashboardTileWideSpan } from "../dashboardLayout";
import type { TimeseriesBlock } from "../types";

const NET_WORTH_PORTFOLIO_GROUP = "net_worth";
/** The home detalle table: month and year rows only. */
const DASHBOARD_DETAIL_PERIODS = ["month", "year"] as const;

/** Overview line dataKeys the daily payload can feed. */
const DAILY_OVERVIEW_LINE_KEYS = new Set([
  "total_nw",
  "real_estate",
  "retirement",
  "brokerage",
  "cash",
  "invested",
  "liabilities",
]);

/** The daily point fields each overview line reads (USD milestone keys are the same on both). */
const DAILY_OVERVIEW_POINT_FIELD: Record<string, string> = {
  total_nw: "net_worth",
  cash: "cash_eqs",
};

type ComboRow = Record<string, string | number | null>;

/** The card strip's figures and the unit they are in. */
type StripCards = { dash: ReturnType<typeof dashPickForNavStrip>; unit: string };

/**
 * The P/L combo's yearly rows: class Δs and Σ Δ sum over the year's months in range,
 * YTD is that Σ Δ, the all-time level is sampled at year-end. `rollupChartPointsByYear` cannot
 * express the YTD: neither a flow nor a year-end level once the first year is cut at the Rango.
 */
const COMBINED_PERF_YEARLY = {
  sumKeys: [
    "delta_retirement",
    "delta_brokerage",
  ],
  ytdKey: "ytd_combined",
  accumKey: "accumulated_earnings",
  totalKey: "delta_combined",
};

/** On the demo's About preview the net-worth lines draw in slowly the first time (a direct load does not). */
const NET_WORTH_DRAW_IN_MS = 3000;

export function DashboardPage() {
  const inAboutPreview = useDashboardAboutPreview();
  const fold = useDashboardFold();
  // The tiles below the fold fetch nothing of their own until they are shown (dashboardFold.ts).
  const belowFoldShown = fold === "full";
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { displayUnit } = useDisplayPreferences();
  const overviewPrefs = useSurfacePrefs("home.overview", "day", "3y");
  const combosPrefs = useSurfacePrefs("home.combos", "month", "3y");
  const perfArea = useSurfaceAreaMode("home.perf");
  const perfPercent = useSurfacePercentMode("home.perf");
  const allocationPrefs = useSurfacePrefs("home.proportional", "month", "total");
  const compositionView = useSurfaceCompositionView("home.proportional");
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  // «Load failed» only once the nav has answered without a net-worth tree; until then the page
  // renders its shell (static title, placeholder charts), dimmed.
  const navSettled = !navPending && !navFetching;
  const netWorthNav = sidebarNav?.net_worth ?? null;

  const navShell = useMemo(
    () => (netWorthNav ? buildGroupPageShellFromNav(netWorthNav) : null),
    [netWorthNav, displayUnit]
  );

  const navSnapshotQuery = useDashboardNavSnapshot(displayUnit);
  const navSnapshot = navSnapshotQuery.data;
  const { data: shapeAccounts } = useAccountsByPortfolioGroup(
    NET_WORTH_PORTFOLIO_GROUP,
    displayUnit,
    Boolean(netWorthNav)
  );
  const bundleQuery = useDashboardBundle(displayUnit);
  const { error } = bundleQuery;
  // The bundle on screen: this unit's, or the one held while it loads (in ITS unit, dimmed).
  const bundle = useHeldUnitQuery(bundleQuery, { queryKey: queryKeys.dashboard(displayUnit), unit: displayUnit });

  useEffect(() => {
    void prefetchDashboardNavSnapshot(queryClient, displayUnit);
    void prefetchAccountsByPortfolioGroup(queryClient, NET_WORTH_PORTFOLIO_GROUP, displayUnit);
    void prefetchDashboardBundle(queryClient, displayUnit);
  }, [queryClient, displayUnit]);

  const placeholderBundle = useMemo(
    () => buildPlaceholderDashboardBundle(displayUnit, navSnapshot?.chart_shape),
    [displayUnit, navSnapshot?.chart_shape]
  );

  const {
    content,
    loading: contentLoading,
    live,
  } = bundleContent(bundle, (d) => Boolean(d.dash && d.ts?.overview));

  // The zero placeholder only while there is no bundle to show at all (first visit).
  const resolved = content ?? placeholderBundle;
  const dash = resolved.dash;
  const ts = resolved.ts;
  const inversionesPerf = resolved.inversionesPerf;

  // Only this unit's live bundle is stored (never a held one under the new unit's key).
  useEffect(() => {
    if (!live) return;
    writeDashboardNavSnapshotCache(live.dash.unit, {
      schema_version: live.dash.schema_version,
      unit: live.dash.unit,
      accounts: live.dash.accounts,
      liabilities_breakdown: live.dash.liabilities_breakdown,
      dashboard_layout: live.dash.dashboard_layout,
      nw_bucket_totals: nwBucketTotalsFromDashTotals(live.dash.totals),
      card_metrics_by_slug: live.dash.card_metrics_by_slug,
      chart_shape: chartShapeFromLoadedDashboardBundle(live),
    });
  }, [live]);


  // No snapshot yet (cold cache): a zero strip from the sidebar nav, in its placeholder phase.
  const placeholderStripDash = useMemo(
    () => (sidebarNav ? buildPlaceholderNavStripDash(sidebarNav) : null),
    [sidebarNav]
  );
  // The strip's cards: this unit's live bundle, else its stored snapshot (updated at 0 when read
  // from storage, so it paints only a strip that shows nothing yet). Across a unit switch the cards
  // on screen stay, dimmed and in THEIR unit, until a copy of the new unit at least as new lands;
  // the bundle's own copy is either live or held (and refetched) by `bundle` above.
  const stripCandidate = useMemo((): UnitCandidate<StripCards> | undefined => {
    if (live) return { data: { dash: live.dash, unit: live.dash.unit }, updatedAt: bundleQuery.dataUpdatedAt };
    if (!navSnapshot) return undefined;
    return {
      data: {
        dash: dashPickForNavStrip({
          accounts: navSnapshot.accounts,
          liabilities_breakdown: navSnapshot.liabilities_breakdown,
          dashboard_layout: navSnapshot.dashboard_layout,
          nw_bucket_totals: navSnapshot.nw_bucket_totals,
          card_metrics_by_slug: navSnapshot.card_metrics_by_slug,
        }),
        unit: navSnapshot.unit,
      },
      updatedAt: navSnapshotQuery.dataUpdatedAt,
    };
  }, [live, bundleQuery.dataUpdatedAt, navSnapshot, navSnapshotQuery.dataUpdatedAt]);
  const strip = useHeldUnitValue({
    candidate: stripCandidate,
    pending: stripCandidate === undefined,
    unit: displayUnit,
    entity: NET_WORTH_PORTFOLIO_GROUP,
    key: displayUnit,
    // An older snapshot waits for the bundle request in flight (joined, never restarted).
    refetch: () => bundleQuery.refetch({ cancelRefetch: false }),
  });
  const stripCards = netWorthNav ? (strip.data ?? null) : null;
  // Nothing to show yet (cold cache): a zero strip from the sidebar nav, in its placeholder phase.
  const stripDash = netWorthNav ? (stripCards?.dash ?? placeholderStripDash) : null;
  // The cards show real numbers (the bundle, a held bundle or a snapshot, never the zero
  // placeholder): the demo's About page shows its preview from then on (dashboardFold.ts).
  const stripReady = stripCards != null;
  const reportStripReady = useContext(DashboardStripReadyContext);
  useEffect(() => {
    if (stripReady) reportStripReady?.();
  }, [stripReady, reportStripReady]);
  const previewShown = useContext(DashboardPreviewShownContext);

  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const overviewIsDaily = overviewPrefs.period === "day";
  const overviewRange = longSurfaceRange(overviewPrefs.range, "3y");
  // Month and year only: a stored «day» (from when the chart offered it) reads as month.
  const combosPeriod = monthYearSurfacePeriod(combosPrefs.period);
  const combosRange = longSurfaceRange(combosPrefs.range, "3y");
  const combosIsYearly = combosPeriod === "year";
  const isYearly = combosIsYearly;

  // Day view: the net-worth chart swaps to the daily series (overview-daily fetch), held like
  // the bundle across a unit or range change (a held daily series is drawn, dimmed, in its unit).
  const overviewDays = timeRangeToDays(overviewRange);
  const overviewDaily = useHeldUnitQuery(
    useDashboardOverviewDaily(displayUnit, overviewDays, overviewIsDaily),
    { queryKey: queryKeys.dashboardOverviewDaily(displayUnit, overviewDays), unit: displayUnit, enabled: overviewIsDaily }
  );
  const overviewDailyData = overviewDaily.data;
  // The value map replaces the composition chart; only a real bundle (live or held) carries it.
  const valueMapRoot = useMemo(
    () => (content ? valueMapRootForPage(content.dash.value_map, "net_worth") : null),
    [content]
  );
  // While nothing is drawn yet the map keeps the last data it drew (in that data's unit).
  const heldValueMap = useHeldValueMap(
    "net_worth",
    valueMapRoot,
    content?.dash.value_map_color_bounds,
    dash.unit
  );
  // Net worth always has group children: the selected view is shown whatever is loading.
  const valueMapShown = compositionView.view === "map";
  const allocationIsDaily = allocationPrefs.period === "day";
  const allocationDays = timeRangeToDays(allocationPrefs.range);
  const allocationDailyEnabled = allocationIsDaily && !valueMapShown && belowFoldShown;
  const allocationDaily = useHeldUnitQuery(
    useDashboardOverviewDaily(displayUnit, allocationDays, allocationDailyEnabled),
    { queryKey: queryKeys.dashboardOverviewDaily(displayUnit, allocationDays), unit: displayUnit, enabled: allocationDailyEnabled }
  );
  const allocationDailyData = allocationDaily.data;
  // The bundle's own loading dims every chart.
  const overviewDailyPending = dailyPayloadPending(overviewIsDaily, overviewDaily);
  const allocationDailyPending = dailyPayloadPending(allocationIsDaily, allocationDaily);
  const valuationChartsLoading = contentLoading || (overviewIsDaily && overviewDaily.loading);
  const allocationLoading = contentLoading || (allocationIsDaily && allocationDaily.loading);
  const dailyOverviewBlock = useMemo(() => {
    if (!overviewIsDaily || overviewDailyPending) return null;
    if (!overviewDailyData?.points.length || !ts?.overview) return null;
    const lines = ts.overview.lines.filter(
      (l) => DAILY_OVERVIEW_LINE_KEYS.has(String(l.dataKey)) || l.level_currency != null
    );
    if (!lines.length) return null;
    const points = overviewDailyData.points.map((p) => {
      const src = p as unknown as Record<string, number | string | null>;
      const row: Record<string, string | number | null> = { as_of_date: p.as_of_date };
      for (const l of lines) {
        const key = String(l.dataKey);
        row[key] = src[DAILY_OVERVIEW_POINT_FIELD[key] ?? key] ?? null;
      }
      return row;
    });
    // The milestone anchors only while both payloads are in the same unit (a held bundle or a
    // held daily series of another unit would mix units).
    return {
      lines,
      points,
      ...(ts.unit === overviewDailyData.unit
        ? { referenceMilestoneByDate: ts.overview.referenceMilestoneByDate }
        : {}),
    };
  }, [overviewIsDaily, overviewDailyPending, overviewDailyData, ts?.overview, ts?.unit]);

  // The P/L + deposits combo arrives built (`inversionesPerf`: the inversiones consolidation's
  // months, deposits joined); the client only cuts it to the Rango and rolls years up.
  const inversionesPerfPoints = useMemo(
    (): ComboRow[] => (inversionesPerf?.points ?? []).map((p) => ({ ...p })),
    [inversionesPerf]
  );

  // The «%» view's yearly rows: the server compounds each year's return, so the client only
  // cuts them to the Rango (the chart does) and never rolls months up.
  const yearlyPctPoints = useMemo(
    (): ComboRow[] => (inversionesPerf?.yearly_pct ?? []).map((p) => ({ ...p })),
    [inversionesPerf]
  );

  const retirementBrokerageForCharts = useMemo(() => {
    if (!inversionesPerfPoints.length) return [];
    if (!isYearly) return inversionesPerfPoints;
    // Months cut at the combos' Rango first, then rolled up: a partial first year.
    return clipMonthsThenRollup(inversionesPerfPoints, "year", combosRange, (months) =>
      rollupPerfPointsYearly(months, COMBINED_PERF_YEARLY)
    );
  }, [inversionesPerfPoints, isYearly, combosRange]);

  const combosLoading = contentLoading;

  // Each valuation chart rolls up (or not) per its OWN period control.
  const overviewBlock = useMemo((): TimeseriesBlock | null => {
    if (!ts?.overview) return null;
    const base = {
      lines: ts.overview.lines,
      points: ts.overview.points,
      referenceMilestoneByDate: ts.overview.referenceMilestoneByDate,
    };
    if (overviewPrefs.period !== "year") return base;
    return { ...base, points: rollupTimeseriesBlockYearEnd(base).points };
  }, [ts?.overview, overviewPrefs.period]);

  const bucketColorBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of dash?.allocation ?? []) {
      m.set(row.group_slug, allocationBucketColor(row.group_slug, row.color_rgb));
    }
    return m;
  }, [dash?.allocation]);
  const retirementColor = bucketColorBySlug.get("retirement") ?? allocationBucketColor("retirement");
  const brokerageColor = bucketColorBySlug.get("brokerage") ?? allocationBucketColor("brokerage");

  const netWorthTableAccounts = useMemo(() => {
    const rows = content ? content.dash.accounts : (navSnapshot?.accounts ?? navShell?.dashAccounts ?? []);
    return netWorthTableAccountsFromDash(rows);
  }, [content, navSnapshot?.accounts, navShell?.dashAccounts]);

  const accountsTreeRoot = useMemo(
    () =>
      netWorthNav && sidebarNav
        ? enrichNavTreeWithAllAccounts(
            netWorthTreeWithLiabilitiesSubtree(netWorthNav, sidebarNav.main),
            shapeAccounts ?? navShell?.accounts ?? []
          )
        : null,
    [netWorthNav, sidebarNav, shapeAccounts, navShell?.accounts]
  );

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  // The blocks are always on hand (placeholder, held or real bundle); the nav only counts once
  // it has answered.
  if ((!netWorthNav && navSettled) || !overviewBlock) {
    return (
      <main>
        <p className="muted">{t("common.loadFailed")}</p>
      </main>
    );
  }

  // Composition chart: shares served with the bundle (monthly) or from
  // the overview-daily payload (none while it is pending: the pending frame); overview line
  // dataKey `cash` maps to the cash_eqs bucket color.
  const allocationBlock = allocationIsDaily
    ? allocationDailyPending
      ? null
      : (allocationDailyData?.allocation_proportional ?? null)
    : (ts.allocation_proportional ?? null);

  // The P/L + deposits combo keeps its `home.combos` control (period + range).
  const combosXAxis = combosIsYearly ? ("year" as const) : ("month" as const);
  const combosControls = (
    <SurfaceControls
      period={combosPeriod}
      onPeriodChange={combosPrefs.setPeriod}
      periodOptions={["month", "year"]}
      range={combosRange}
      rangeOptions={LONG_RANGE_OPTIONS}
      onRangeChange={combosPrefs.setRange}
    />
  );
  const perfControls = (
    <span className="surface-controls">
      <label className="surface-controls__label">
        <input
          type="checkbox"
          checked={perfArea.area === "total"}
          onChange={(e) => perfArea.setArea(e.target.checked ? "total" : "ytd")}
        />
        {t("dashboard.sections.areaTotalToggle")}
      </label>
      <label className="surface-controls__label">
        <input
          type="checkbox"
          checked={perfPercent.percent}
          onChange={(e) => perfPercent.setPercent(e.target.checked)}
        />
        {t("dashboard.sections.percentToggle")}
      </label>
      {combosControls}
    </span>
  );

  // The «%» view: the same granularity, the server's return fields in place of the money ones.
  const perfPctView = perfPercent.percent;
  const perfChartPoints: ComboRow[] = perfPctView
    ? isYearly
      ? yearlyPctPoints
      : retirementBrokerageForCharts
    : retirementBrokerageForCharts;
  const pctRetirementName = isYearly
    ? t("dashboard.percentMode.retirementYearly")
    : t("dashboard.percentMode.retirementMonthly");
  const pctBrokerageName = isYearly
    ? t("dashboard.percentMode.brokerageYearly")
    : t("dashboard.percentMode.brokerageMonthly");
  const pctCombinedName = isYearly
    ? t("dashboard.percentMode.combinedYearly")
    : t("dashboard.percentMode.combinedMonthly");

  const dashboardCharts = (
    <>
      <PageGridTile
        id="net-worth-chart"
        className="chart-grid chart-grid--full-width-stack"
      >
        <LineChartPanel
          title={t("dashboard.sections.overviewTitle")}
          block={
            // Until a real bundle is on hand (live or held), every period shows the pending frame
            // (title, controls, legend), never the placeholder's zero lines: those only flashed
            // before the draw-in.
            overviewIsDaily
              ? (dailyOverviewBlock ?? { lines: overviewBlock.lines, points: [] })
              : content
                ? overviewBlock
                : { lines: overviewBlock.lines, points: [] }
          }
          displayUnit={overviewIsDaily ? (overviewDailyData?.unit ?? ts.unit) : ts.unit}
          thickKey="total_nw"
          includeAccumulatedLines={false}
          colorPlan={{ kind: "dashboard-overview" }}
          drawInMs={inAboutPreview ? NET_WORTH_DRAW_IN_MS : undefined}
          drawInHold={!previewShown}
          xAxisGranularity={
            overviewIsDaily ? "day" : overviewPrefs.period === "year" ? "year" : "month"
          }
          timeRange={overviewRange}
          athMarker={
            overviewIsDaily
              ? dailyOverviewBlock
                ? (overviewDailyData?.ath ?? null)
                : null
              : overviewPrefs.period === "year"
                ? (ts.overview?.ath?.year ?? null)
                : (ts.overview?.ath?.month ?? null)
          }
          controls={
            <SurfaceControls
              period={overviewPrefs.period}
              onPeriodChange={overviewPrefs.setPeriod}
              range={overviewRange}
              onRangeChange={overviewPrefs.setRange}
              rangeOptions={LONG_RANGE_OPTIONS}
            />
          }
          loading={valuationChartsLoading}
        />
      </PageGridTile>

    </>
  );

  // Below the cards, the main chart and the rail: two equal columns on the big desktop.
  const dashboardPairedCharts = (
    <>
      <DashboardFlowsChart displayUnit={displayUnit} alone={retirementBrokerageForCharts.length === 0} />

      {retirementBrokerageForCharts.length > 0 ? (
        <>
          <PageGridTile
            id="perf-combo"
            wideSpan={dashboardTileWideSpan("perf-combo")}
            smallSpan={dashboardTileSmallSpan("perf-combo")}
            className="chart-grid chart-grid--full-line"
          >
            <MonthlyPerformanceComboChart
              title={
                isYearly ? t("dashboard.sections.perfChartTitleYearly") : t("dashboard.sections.perfChartTitleMonthly")
              }
              points={perfChartPoints}
              displayUnit={inversionesPerf?.unit ?? ts.unit}
              valueFormat={perfPctView ? "percent" : "money"}
              xAxisGranularity={combosXAxis}
              timeRange={combosRange}
              controls={perfControls}
              barSeries={perfPctView ? [
                // Each class's own return, side by side (no stack).
                { dataKey: "pct_retirement", name: pctRetirementName, color: retirementColor },
                { dataKey: "pct_brokerage", name: pctBrokerageName, color: brokerageColor },
              ] : [
                {
                  dataKey: "delta_retirement",
                  name: isYearly
                    ? t("dashboard.sections.deltaRetirementYearly")
                    : t("dashboard.sections.deltaRetirementMonthly"),
                  color: retirementColor,
                  stackId: "pl",
                },
                {
                  dataKey: "delta_brokerage",
                  name: isYearly
                    ? t("dashboard.sections.deltaBrokerageYearly")
                    : t("dashboard.sections.deltaBrokerageMonthly"),
                  color: brokerageColor,
                  stackId: "pl",
                },
              ]}
              // The YTD area always shows; the «Total» toggle adds the all-time P/L as a line.
              areaKey={perfPctView ? "ytd_pct" : "ytd_combined"}
              areaName={
                isYearly ? t("dashboard.sections.yearTotalCombined") : t("dashboard.sections.ytdCombined")
              }
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes
              lineSeries={perfPctView ? [
                ...(perfArea.area === "total"
                  ? [
                      {
                        dataKey: "accumulated_pct",
                        name: t("dashboard.percentMode.accumulated"),
                        stroke: "#e2e8f0",
                        strokeWidth: 2,
                        strokeDasharray: "",
                      },
                    ]
                  : []),
                { dataKey: "pct_combined", name: pctCombinedName, stroke: "#38bdf8" },
              ] : [
                ...(perfArea.area === "total"
                  ? [
                      {
                        dataKey: "accumulated_earnings",
                        name: t("dashboard.sections.accumulatedEarnings"),
                        stroke: "#e2e8f0",
                        strokeWidth: 2,
                        strokeDasharray: "",
                      },
                    ]
                  : []),
                {
                  dataKey: "delta_combined",
                  name: isYearly ? t("dashboard.combinedAnnualDelta") : t("dashboard.combinedMonthlyDelta"),
                  stroke: "#38bdf8",
                },
              ]}
              loading={combosLoading}
            />
          </PageGridTile>
        </>
      ) : null}
    </>
  );

  // From 880 one column with Rentabilidad under it, beside the detalle table (GroupInfoBase).
  const dashboardAllocation = (
    <PageGridTile id="allocation" className="chart-grid chart-grid--full-line">
      {valueMapShown ? (
        <ValueMapPanel
          title={t("dashboard.allocation.title")}
          surfaceId="home.map"
          view={compositionView.view}
          onViewChange={compositionView.setView}
          root={heldValueMap.root}
          bounds={heldValueMap.bounds}
          unit={heldValueMap.unit}
          loading={contentLoading}
        />
      ) : (
        <ProportionalAreaChart
          title={t("dashboard.allocation.title")}
          block={allocationBlock}
          xAxisGranularity={
            allocationIsDaily && allocationBlock
              ? "day"
              : allocationPrefs.period === "year"
                ? "year"
                : "month"
          }
          timeRange={allocationPrefs.range}
          controls={
            <SurfaceControls
              view={compositionView.view}
              onViewChange={compositionView.setView}
              period={allocationPrefs.period}
              onPeriodChange={allocationPrefs.setPeriod}
              range={allocationPrefs.range}
              onRangeChange={allocationPrefs.setRange}
            />
          }
          colorFor={(line) => allocationBucketColor(line.dataKey, line.color_rgb)}
          loading={allocationLoading}
        />
      )}
    </PageGridTile>
  );

  return (
    <GroupInfoBase
      loading={contentLoading}
      portfolio={
        netWorthNav && stripDash
          ? {
              navNode: netWorthNav,
              groupSlug: "net_worth",
              dash: stripDash,
              unit: stripCards?.unit ?? displayUnit,
            }
          : null
      }
      coldStripShape={DASHBOARD_COLD_STRIP}
      charts={dashboardCharts}
      tableAccounts={netWorthTableAccounts}
      dashboard={{
        mainClassName: "page-dashboard",
        serverPaginatedMonthlyDetail: true,
        detailPeriods: DASHBOARD_DETAIL_PERIODS,
        flowsTitleKey: "dashboard.wealthFlowsTitle",
        flowsExcludeSpending: true,
        pairs: dashboardPairedCharts,
        rail: (
          <>
            {/* One row whenever both fit, «Próximos pagos» taking what the periods leave (page-grid.css `.dashboard-flows-pair`); stacked in the rail. */}
            <div className="page-tile dashboard-flows-pair">
              <DashboardFlowsPeriods displayUnit={displayUnit} />
              <UpcomingPaymentsPanel data={bundle.data?.upcomingPayments ?? null} loading={contentLoading} />
            </div>
            <LatestMovementsTable />
          </>
        ),
        allocation: dashboardAllocation,
        allocationStackSpans: dashboardAllocationStackSpans(),
        tileWideSpan: dashboardTileWideSpan,
        tileSmallSpan: dashboardTileSmallSpan,
        fold,
      }}
      accountsTree={
        accountsTreeRoot ? (
          <NavAccountsTree
            root={accountsTreeRoot}
            titleI18nKey="dashboard.accountsTreeTitle"
            emptyI18nKey="dashboard.accountsTreeEmpty"
          />
        ) : null
      }
      exportSlot={<ExportToolbarButton exportPath="/api/groups/net_worth/export.xlsx" />}
    />
  );
}
