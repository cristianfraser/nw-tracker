import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MonthlyPerformanceComboChart,
  ProportionalAreaChart,
  ValuationLineCharts,
} from "../components/charts/lazyCharts";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { CcUpcomingPaymentsPanel } from "../components/dashboard/CcUpcomingPaymentsPanel";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { LatestExpensesTable } from "../components/dashboard/LatestExpensesTable";
import { ExportToolbarButton } from "../components/export/ExportModal";
import {
  prefetchAccountsByPortfolioGroup,
  prefetchDashboardBundle,
  prefetchDashboardNavSnapshot,
} from "../queries/displayUnitQueries";
import { dashPickForNavStrip } from "../queries/fetchers";
import { otherDisplayUnit } from "../queries/keys";
import { isBundleContentLoading, useRealBundleForContent } from "../queries/pageShapeReady";
import {
  nwBucketTotalsFromDashTotals,
  writeDashboardNavSnapshotCache,
} from "../queries/dashboardNavSnapshotCache";
import {
  useAccountsByPortfolioGroup,
  useDashboardBundle,
  useDashboardNavSnapshot,
  useDashboardOverviewDaily,
  useInversionesPerfDaily,
  useSidebarNav,
} from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { allocationBucketColor, desaturateStroke } from "../chartColors";
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "../dashboardTimeseriesYearly";
import { useTranslation } from "../i18n";
import { buildGroupPageShellFromNav } from "../placeholders/groupPageShellFromNav";
import {
  buildPlaceholderDashboardBundle,
  buildPlaceholderNavStripDash,
  chartShapeFromLoadedDashboardBundle,
} from "../placeholders/dashboardPagePlaceholders";
import { enrichNavTreeWithAllAccounts } from "../navAccountsTreeEnrich";
import { resolveNetWorthGroupLabel } from "../sidebarNavFromApi";
import { DASHBOARD_COLD_STRIP } from "../coldPageShape";
import { netWorthTableAccountsFromDash } from "../portfolioDashboardBuckets";
import { clipMonthsThenRollup, timeRangeToDays } from "../timeRange";
import { useSurfaceAreaMode, useSurfaceCompositionView, useSurfacePrefs } from "../surfaceDisplayPrefs";
import { useHeldValueMap, ValueMapPanel, valueMapRootForPage } from "../components/charts/ValueMapPanel";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { DashboardFlowsSummary } from "../components/dashboard/DashboardFlowsSummary";
import type { TimeseriesBlock } from "../types";

const NET_WORTH_PORTFOLIO_GROUP = "net_worth";

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

/**
 * The P/L combo's yearly rows: class Δs, Σ Δ and deposits sum over the year's months in range,
 * YTD is that Σ Δ, the all-time level is sampled at year-end. `rollupChartPointsByYear` cannot
 * express the YTD: neither a flow nor a year-end level once the first year is cut at the Rango.
 */
const COMBINED_PERF_YEARLY = {
  sumKeys: [
    "delta_retirement",
    "delta_brokerage",
    "deposits_retirement",
    "deposits_brokerage",
    "deposits_inversiones",
  ],
  ytdKey: "ytd_combined",
  accumKey: "accumulated_earnings",
  totalKey: "delta_combined",
};

export function DashboardPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { displayUnit } = useDisplayPreferences();
  const overviewPrefs = useSurfacePrefs("home.overview", "day", "3y");
  const principalesPrefs = useSurfacePrefs("home.principales", "day", "3y");
  const combosPrefs = useSurfacePrefs("home.combos", "month", "3y");
  const perfArea = useSurfaceAreaMode("home.perf");
  const allocationPrefs = useSurfacePrefs("home.proportional", "month", "total");
  const compositionView = useSurfaceCompositionView("home.proportional");
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav();
  // «Load failed» only once the nav has answered without a net-worth tree; until then the page
  // renders its shell (static title, placeholder charts), dimmed.
  const navSettled = !navPending && !navFetching;
  const pageTitle = resolveNetWorthGroupLabel(sidebarNav);
  const netWorthNav = sidebarNav?.net_worth ?? null;

  const navShell = useMemo(
    () => (netWorthNav ? buildGroupPageShellFromNav(netWorthNav, displayUnit) : null),
    [netWorthNav, displayUnit]
  );

  const { data: navSnapshot } = useDashboardNavSnapshot(displayUnit);
  const { data: shapeAccounts } = useAccountsByPortfolioGroup(
    NET_WORTH_PORTFOLIO_GROUP,
    displayUnit,
    Boolean(netWorthNav)
  );
  const {
    data,
    error,
    isPending: bundlePending,
    isPlaceholderData,
  } = useDashboardBundle(displayUnit);

  useEffect(() => {
    void prefetchDashboardNavSnapshot(queryClient, displayUnit);
    void prefetchAccountsByPortfolioGroup(queryClient, NET_WORTH_PORTFOLIO_GROUP, displayUnit);
    void prefetchDashboardBundle(queryClient, displayUnit);
  }, [queryClient, displayUnit]);

  const placeholderBundle = useMemo(
    () => buildPlaceholderDashboardBundle(displayUnit, navSnapshot?.chart_shape),
    [displayUnit, navSnapshot?.chart_shape]
  );

  const bundleReady = Boolean(
    data?.dash && data?.ts?.overview && data?.ts?.accounts_ex_property
  );
  const useRealBundle = useRealBundleForContent(isPlaceholderData, bundleReady);
  const contentLoading = isBundleContentLoading({
    isPending: bundlePending,
    isPlaceholderData,
    bundleReady,
  });

  const resolved = useRealBundle && data ? data : placeholderBundle;
  const dash = resolved.dash;
  const ts = resolved.ts;
  const inversionesPerf = resolved.inversionesPerf;

  useEffect(() => {
    if (!useRealBundle || !data) return;
    writeDashboardNavSnapshotCache(displayUnit, {
      accounts: data.dash.accounts,
      liabilities_breakdown: data.dash.liabilities_breakdown,
      dashboard_layout: data.dash.dashboard_layout,
      nw_bucket_totals: nwBucketTotalsFromDashTotals(data.dash.totals),
      card_metrics_by_slug: data.dash.card_metrics_by_slug,
      chart_shape: chartShapeFromLoadedDashboardBundle(data),
    });
  }, [useRealBundle, data, displayUnit]);

  const overviewPoints = ts?.overview?.points ?? [];

  // No snapshot yet (cold cache): a zero strip from the sidebar nav, in its placeholder phase.
  const placeholderStripDash = useMemo(
    () => (sidebarNav ? buildPlaceholderNavStripDash(sidebarNav, displayUnit) : null),
    [sidebarNav, displayUnit]
  );
  // The page holds the previous unit's bundle while the new unit loads (same-entity keep-previous).
  const holdingPrevUnit = isPlaceholderData && bundleReady && data != null;
  // Strip cards during a unit switch: the new unit's stored snapshot when it has one, else the
  // previous unit's values, dimmed and in THEIR unit — the cards then flip to the new values once
  // the bundle lands, never through a blank strip or an fx-converted guess.
  const stripFromHeldBundle = holdingPrevUnit && !navSnapshot;
  const stripShowUsd = (stripFromHeldBundle ? otherDisplayUnit(displayUnit) : displayUnit) === "usd";
  const dashForStrip = useMemo(() => {
    if (!netWorthNav) return null;
    if (useRealBundle && data) return data.dash;
    if (stripFromHeldBundle && data) return data.dash;
    if (!navSnapshot) return placeholderStripDash;
    return dashPickForNavStrip(
      {
        accounts: navSnapshot.accounts,
        liabilities_breakdown: navSnapshot.liabilities_breakdown,
        dashboard_layout: navSnapshot.dashboard_layout,
        nw_bucket_totals: navSnapshot.nw_bucket_totals,
        card_metrics_by_slug: navSnapshot.card_metrics_by_slug,
        overviewPoints,
      }
    );
  }, [netWorthNav, useRealBundle, stripFromHeldBundle, data, navSnapshot, overviewPoints, placeholderStripDash]);

  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const overviewIsDaily = overviewPrefs.period === "day";
  const principalesIsDaily = principalesPrefs.period === "day";
  const combosIsDaily = combosPrefs.period === "day";
  const combosIsYearly = combosPrefs.period === "year";
  const isYearly = combosIsYearly;

  // Day view: each of the two valuation charts swaps to daily series from its own
  // overview-daily fetch (surfaces that agree on the range dedupe into one request).
  const overviewDaily = useDashboardOverviewDaily(
    displayUnit,
    timeRangeToDays(overviewPrefs.range),
    overviewIsDaily
  );
  const overviewDailyData = overviewDaily.data;
  const principalesDaily = useDashboardOverviewDaily(
    displayUnit,
    timeRangeToDays(principalesPrefs.range),
    principalesIsDaily
  );
  const principalesDailyData = principalesDaily.data;
  // The value map replaces the composition chart; only the real bundle carries it.
  const valueMapRoot = useMemo(
    () =>
      useRealBundle && data
        ? valueMapRootForPage(data.dash.value_map, "net_worth", displayUnit)
        : null,
    [useRealBundle, data, displayUnit]
  );
  // While a unit switch or refetch loads, the map keeps the last data it drew (old unit).
  const heldValueMap = useHeldValueMap(
    "net_worth",
    valueMapRoot,
    useRealBundle ? data?.dash.value_map_color_bounds : undefined,
    displayUnit
  );
  // Net worth always has group children: the selected view is shown whatever is loading.
  const valueMapShown = compositionView.view === "map";
  const allocationIsDaily = allocationPrefs.period === "day";
  const allocationDaily = useDashboardOverviewDaily(
    displayUnit,
    timeRangeToDays(allocationPrefs.range),
    allocationIsDaily && !valueMapShown
  );
  const allocationDailyData = allocationDaily.data;
  // A Diario chart shows the monthly block (or its frame), dimmed, until its daily payload is
  // this unit's; the bundle's own loading dims every chart.
  const dailyLoading = (on: boolean, q: { isPending: boolean; isPlaceholderData: boolean }) =>
    on && (q.isPending || q.isPlaceholderData);
  const valuationChartsLoading =
    contentLoading ||
    dailyLoading(overviewIsDaily, overviewDaily) ||
    dailyLoading(principalesIsDaily, principalesDaily);
  const allocationLoading = contentLoading || dailyLoading(allocationIsDaily, allocationDaily);
  const dailyOverviewBlock = useMemo(() => {
    if (!overviewIsDaily || !overviewDailyData?.points.length || !ts?.overview) return null;
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
    // The milestone anchors only while both payloads are in the same unit (a held prior-unit
    // monthly bundle would mix units).
    return {
      lines,
      points,
      ...(ts.unit === overviewDailyData.unit
        ? { referenceMilestoneByDate: ts.overview.referenceMilestoneByDate }
        : {}),
    };
  }, [overviewIsDaily, overviewDailyData, ts?.overview, ts?.unit]);

  // Day mode: «Cuentas principales» swaps to the per-child daily lines. Borrow the monthly
  // block's account metadata (ids/colors/labels) so line identities survive the M↔D toggle,
  // and pair each account's dataKey with the daily values (index-aligned to the daily grid).
  const dailyPrimaryBlock = useMemo(() => {
    const accounts = ts?.accounts_ex_property?.accounts;
    if (!principalesIsDaily || !principalesDailyData?.primary_lines?.length || !accounts?.length)
      return null;
    const valuesByKey = new Map(principalesDailyData.primary_lines.map((l) => [l.dataKey, l.values]));
    const points = principalesDailyData.points.map((p, i) => {
      const row: Record<string, string | number | null> = { as_of_date: p.as_of_date };
      for (const a of accounts) {
        const vals = valuesByKey.get(a.dataKey);
        row[a.dataKey] = vals ? (vals[i] ?? null) : null;
      }
      return row;
    });
    return { accounts, points };
  }, [principalesIsDaily, principalesDailyData, ts?.accounts_ex_property]);

  // The P/L + deposits combo arrives built (`inversionesPerf`: the inversiones consolidation's
  // months, deposits joined); the client only cuts it to the Rango and rolls years up.
  const inversionesPerfPoints = useMemo(
    (): ComboRow[] => (inversionesPerf?.points ?? []).map((p) => ({ ...p })),
    [inversionesPerf]
  );

  const retirementBrokerageForCharts = useMemo(() => {
    if (!inversionesPerfPoints.length) return [];
    if (!isYearly) return inversionesPerfPoints;
    // Months cut at the combos' Rango first, then rolled up: a partial first year.
    return clipMonthsThenRollup(inversionesPerfPoints, "year", combosPrefs.range, (months) =>
      rollupPerfPointsYearly(months, COMBINED_PERF_YEARLY)
    );
  }, [inversionesPerfPoints, isYearly, combosPrefs.range]);

  // Day mode: the server's day combo (retirement + brokerage day bars and deposits, running
  // levels anchored on the monthly consolidation).
  const inversionesDaily = useInversionesPerfDaily(
    displayUnit,
    timeRangeToDays(combosPrefs.range),
    combosIsDaily
  );
  const combosLoading = contentLoading || dailyLoading(combosIsDaily, inversionesDaily);
  const dailyRetirementBrokeragePoints = useMemo((): ComboRow[] | null => {
    if (!combosIsDaily) return null;
    const pts = inversionesDaily.data?.points;
    return pts?.length ? pts.map((p) => ({ ...p })) : null;
  }, [combosIsDaily, inversionesDaily.data]);

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

  const principalesBlock = useMemo(() => {
    if (!ts?.accounts_ex_property) return null;
    return principalesPrefs.period === "year"
      ? rollupTimeseriesBlockYearEnd(ts.accounts_ex_property)
      : ts.accounts_ex_property;
  }, [ts?.accounts_ex_property, principalesPrefs.period]);

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
    const rows =
      useRealBundle && data
        ? data.dash.accounts
        : (navSnapshot?.accounts ?? navShell?.dashAccounts ?? []);
    return netWorthTableAccountsFromDash(rows);
  }, [useRealBundle, data, navSnapshot?.accounts, navShell?.dashAccounts]);

  const accountsTreeRoot = useMemo(
    () =>
      netWorthNav
        ? enrichNavTreeWithAllAccounts(netWorthNav, shapeAccounts ?? navShell?.accounts ?? [])
        : null,
    [netWorthNav, shapeAccounts, navShell?.accounts]
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
  if ((!netWorthNav && navSettled) || !overviewBlock || !principalesBlock) {
    return (
      <main>
        <p className="muted">{t("common.loadFailed")}</p>
      </main>
    );
  }

  // Composition chart (pie replacement): shares served with the bundle (monthly) or from
  // the overview-daily payload; overview line dataKey `cash` maps to the cash_eqs bucket color.
  const allocationBlock = allocationIsDaily
    ? (allocationDailyData?.allocation_proportional ?? null)
    : (ts.allocation_proportional ?? null);

  // The P/L + deposits combo keeps its `home.combos` control (period + range).
  const combosXAxis = dailyRetirementBrokeragePoints
    ? ("day" as const)
    : combosIsYearly
      ? ("year" as const)
      : ("month" as const);
  const combosControls = (
    <SurfaceControls
      period={combosPrefs.period}
      onPeriodChange={combosPrefs.setPeriod}
      range={combosPrefs.range}
      onRangeChange={combosPrefs.setRange}
    />
  );
  const perfControls = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}>
        <input
          type="checkbox"
          checked={perfArea.area === "total"}
          onChange={(e) => perfArea.setArea(e.target.checked ? "total" : "ytd")}
        />
        {t("dashboard.sections.areaTotalToggle")}
      </label>
      {combosControls}
    </span>
  );

  const dashboardCharts = (
    <>
      <ValuationLineCharts
        displayUnit={displayUnit}
        primaryTitle={t("dashboard.sections.overviewTitle")}
        primary={dailyOverviewBlock ?? overviewBlock}
        secondaryTitle={t("dashboard.sections.primaryAccountsTitle")}
        secondary={dailyPrimaryBlock ?? principalesBlock}
        thickLineDataKey="total_nw"
        includeAccumulatedLines={false}
        primaryColorPlan={{ kind: "dashboard-overview" }}
        secondaryColorPlan={{ kind: "dashboard-primary" }}
        primaryXAxisGranularity={
          dailyOverviewBlock ? "day" : overviewPrefs.period === "year" ? "year" : "month"
        }
        secondaryXAxisGranularity={
          dailyPrimaryBlock ? "day" : principalesPrefs.period === "year" ? "year" : "month"
        }
        primaryTimeRange={overviewPrefs.range}
        secondaryTimeRange={principalesPrefs.range}
        primaryAthMarker={
          dailyOverviewBlock
            ? (overviewDailyData?.ath ?? null)
            : overviewPrefs.period === "year"
              ? (ts.overview?.ath?.year ?? null)
              : (ts.overview?.ath?.month ?? null)
        }
        primaryControls={
          <SurfaceControls
            period={overviewPrefs.period}
            onPeriodChange={overviewPrefs.setPeriod}
            range={overviewPrefs.range}
            onRangeChange={overviewPrefs.setRange}
          />
        }
        secondaryControls={
          <SurfaceControls
            period={principalesPrefs.period}
            onPeriodChange={principalesPrefs.setPeriod}
            range={principalesPrefs.range}
            onRangeChange={principalesPrefs.setRange}
          />
        }
        chartLayout="fullWidthStack"
        loading={valuationChartsLoading}
      />

      <DashboardFlowsSummary displayUnit={displayUnit} />

      <CcUpcomingPaymentsPanel data={data?.ccUpcomingPayments ?? null} loading={contentLoading} />

      {retirementBrokerageForCharts.length > 0 ? (
        <>
          <div className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
            <MonthlyPerformanceComboChart
              title={
                isYearly ? t("dashboard.sections.perfChartTitleYearly") : t("dashboard.sections.perfChartTitleMonthly")
              }
              points={dailyRetirementBrokeragePoints ?? retirementBrokerageForCharts}
              displayUnit={displayUnit}
              xAxisGranularity={combosXAxis}
              timeRange={combosPrefs.range}
              controls={perfControls}
              barSeries={[
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
                // Deposits stack beside the P/L one, each class in its own hue, less saturated.
                {
                  dataKey: "deposits_retirement",
                  name: isYearly
                    ? t("dashboard.sections.depositsRetirementYearly")
                    : t("dashboard.sections.depositsRetirementMonthly"),
                  color: desaturateStroke(retirementColor),
                  stackId: "deposits",
                },
                {
                  dataKey: "deposits_brokerage",
                  name: isYearly
                    ? t("dashboard.sections.depositsBrokerageYearly")
                    : t("dashboard.sections.depositsBrokerageMonthly"),
                  color: desaturateStroke(brokerageColor),
                  stackId: "deposits",
                },
              ]}
              // The YTD area always shows; «Total acumulado» adds the all-time P/L as a line.
              areaKey="ytd_combined"
              areaName={
                isYearly ? t("dashboard.sections.yearTotalCombined") : t("dashboard.sections.ytdCombined")
              }
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes
              lineSeries={[
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
                {
                  dataKey: "deposits_inversiones",
                  name: isYearly
                    ? t("dashboard.combinedAnnualDeposits")
                    : t("dashboard.combinedMonthlyDeposits"),
                  stroke: "#a78bfa",
                },
              ]}
              loading={combosLoading}
            />
          </div>
        </>
      ) : null}

      <div className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
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
      </div>
    </>
  );

  return (
    <GroupInfoBase
      mainClassName="page-dashboard"
      title={pageTitle}
      loading={contentLoading}
      portfolio={
        netWorthNav && dashForStrip
          ? {
              navNode: netWorthNav,
              groupSlug: "net_worth",
              dash: dashForStrip,
              overviewPoints,
              showUsd: stripShowUsd,
              animated: true,
            }
          : null
      }
      coldStripShape={DASHBOARD_COLD_STRIP}
      charts={dashboardCharts}
      tableAccounts={netWorthTableAccounts}
      serverPaginatedMonthlyDetail
      flowsTitleKey="dashboard.wealthFlowsTitle"
      flowsExcludeSpending
      afterFlows={<LatestExpensesTable />}
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
