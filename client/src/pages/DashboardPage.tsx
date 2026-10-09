import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChartPanel,
  MonthlyPerformanceComboChart,
  ProportionalAreaChart,
  ValuationLineCharts,
} from "../components/charts/lazyCharts";
import { NavAccountsTree } from "../components/nav/NavAccountsTree";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { ExportToolbarButton } from "../components/export/ExportModal";
import {
  prefetchAccountsByPortfolioGroup,
  prefetchDashboardBundle,
  prefetchDashboardNavSnapshot,
} from "../queries/displayUnitQueries";
import { dashPickForNavStrip } from "../queries/fetchers";
import type { DisplayUnit } from "../queries/keys";
import { isBundleContentLoading, useRealBundleForContent } from "../queries/pageShapeReady";
import {
  nwBucketTotalsFromDashTotals,
  writeDashboardNavSnapshotCache,
} from "../queries/dashboardNavSnapshotCache";
import { readFxLatestCache, writeFxLatestCache } from "../queries/fxLatestCache";
import {
  convertDashboardBundleUnit,
  resolveClpPerUsdForKeepPrev,
} from "../placeholders/keepPrevBundleUnit";
import {
  useAccountsByPortfolioGroup,
  useDashboardBundle,
  useDashboardNavSnapshot,
  useDashboardOverviewDaily,
  useSidebarNav,
} from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { allocationBucketColor } from "../chartColors";
import { appendTrailingMovingAverage } from "../chartMovingAverage";
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "../dashboardTimeseriesYearly";
import { rollupChartPointsByYear } from "../flowsDisplay";
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
import { buildDailyPerfComboPoints } from "../dailyPerfCombo";
import { useDailySeries } from "../queries/hooks";
import { useSurfaceCompositionView, useSurfacePrefs } from "../surfaceDisplayPrefs";
import { useHeldValueMap, ValueMapPanel, valueMapRootForPage } from "../components/charts/ValueMapPanel";
import { SurfaceControls } from "../components/ui/SurfaceControls";
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

type ComboRow = Record<string, string | number | null>;
type DepositedPoint = { as_of_date: string; deposited: number };

/** The P/L combos' yearly rows: class Δs and the combined Δ sum, accumulated is year-end. */
function rollupCombinedPerfYearly(months: readonly ComboRow[]): ComboRow[] {
  return rollupPerfPointsYearly(months, {
    sumKeys: ["delta_retirement", "delta_brokerage"],
    ytdKey: "ytd_combined",
    accumKey: "accumulated_earnings",
    totalKey: "delta_combined",
  });
}

function rollupDepositedByYear(months: readonly DepositedPoint[]): DepositedPoint[] {
  return rollupChartPointsByYear(months, ["deposited"]);
}

/** Retiro + brokerage net deposits of each row's period, joined by date (0 when none). */
function withInversionesDeposits(
  rows: readonly ComboRow[],
  deposits: readonly DepositedPoint[]
): ComboRow[] {
  const byDate = new Map(deposits.map((p) => [p.as_of_date, p.deposited]));
  return rows.map((row) => ({
    ...row,
    deposits_inversiones: byDate.get(String(row.as_of_date ?? "")) ?? 0,
  }));
}

function withInversionesMovingAverages(rows: ComboRow[]): ComboRow[] {
  return appendTrailingMovingAverage(
    appendTrailingMovingAverage(rows, "delta_combined", "delta_combined_ma3"),
    "deposits_inversiones",
    "deposits_inversiones_ma3"
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { displayUnit } = useDisplayPreferences();
  const overviewPrefs = useSurfacePrefs("home.overview", "day", "3y");
  const principalesPrefs = useSurfacePrefs("home.principales", "day", "3y");
  const patrimonioPrefs = useSurfacePrefs("home.patrimonio", "day", "3y");
  const combosPrefs = useSurfacePrefs("home.combos", "month", "3y");
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
    isFetching,
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

  // During a CLP↔USD switch, keep the previous unit's charts on screen (FX-converted to the
  // target unit) instead of blinking to the flat-zero placeholder; snaps to exact when the real
  // bundle resolves. `isPlaceholderData` here means the query key (unit) changed with prior data held.
  const keepPrevBundle = useMemo(() => {
    if (!isPlaceholderData || !bundleReady || !data) return null;
    const rate = resolveClpPerUsdForKeepPrev(data.fx, readFxLatestCache());
    if (rate == null) return null;
    return convertDashboardBundleUnit(data, displayUnit, rate);
  }, [isPlaceholderData, bundleReady, data, displayUnit]);

  const resolved = useRealBundle && data ? data : (keepPrevBundle ?? placeholderBundle);
  const dash = resolved.dash;
  const ts = resolved.ts;
  const retirementPerf = resolved.retirementPerf;
  const brokeragePerf = resolved.brokeragePerf;

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
    writeFxLatestCache(data.fx);
  }, [useRealBundle, data, displayUnit]);

  const overviewPoints = ts?.overview?.points ?? [];

  // No snapshot yet (cold cache): a zero strip from the sidebar nav, in its placeholder phase.
  const placeholderStripDash = useMemo(
    () => (sidebarNav ? buildPlaceholderNavStripDash(sidebarNav, displayUnit) : null),
    [sidebarNav, displayUnit]
  );
  const dashForStrip = useMemo(() => {
    if (!netWorthNav) return null;
    if (useRealBundle && data) return data.dash;
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
  }, [netWorthNav, useRealBundle, data, navSnapshot, overviewPoints, placeholderStripDash]);

  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const showUsd = displayUnit === "usd";
  const unitSwitching = isFetching && (isPlaceholderData || !bundlePending);
  const overviewIsDaily = overviewPrefs.period === "day";
  const principalesIsDaily = principalesPrefs.period === "day";
  const patrimonioIsDaily = patrimonioPrefs.period === "day";
  const combosIsDaily = combosPrefs.period === "day";
  const combosIsYearly = combosPrefs.period === "year";
  const isYearly = combosIsYearly;

  // Day view: each of the three valuation charts swaps to daily series from its own
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
  const patrimonioDaily = useDashboardOverviewDaily(
    displayUnit,
    timeRangeToDays(patrimonioPrefs.range),
    patrimonioIsDaily
  );
  const patrimonioDailyData = patrimonioDaily.data;
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
  const patrimonioLoading = contentLoading || dailyLoading(patrimonioIsDaily, patrimonioDaily);
  const allocationLoading = contentLoading || dailyLoading(allocationIsDaily, allocationDaily);
  const dailyOverviewBlock = useMemo(() => {
    if (!overviewIsDaily || !overviewDailyData?.points.length || !ts?.overview) return null;
    const lines = ts.overview.lines.filter((l) => DAILY_OVERVIEW_LINE_KEYS.has(String(l.dataKey)));
    if (!lines.length) return null;
    const points = overviewDailyData.points.map((p) => ({
      as_of_date: p.as_of_date,
      total_nw: p.net_worth,
      real_estate: p.real_estate,
      retirement: p.retirement,
      brokerage: p.brokerage,
      cash: p.cash_eqs,
      invested: p.invested,
      liabilities: p.liabilities,
    }));
    return { lines, points };
  }, [overviewIsDaily, overviewDailyData, ts?.overview]);

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

  // Day mode: «Patrimonio neto vs invested» swaps to daily points (in the daily payload's
  // unit). Borrow the monthly block's line metadata; its milestone anchors only while both
  // payloads are in the same unit (a held prior-unit monthly block would mix units).
  const dailyPatrimonioBlock = useMemo(() => {
    const src = ts?.patrimonio_usd_milestones_chart;
    if (!patrimonioIsDaily || !patrimonioDailyData?.patrimonio?.length || !src) return null;
    const { referenceMilestoneByDate, ...rest } = src;
    return {
      ...rest,
      ...(src.unit === patrimonioDailyData.unit ? { referenceMilestoneByDate } : {}),
      unit: patrimonioDailyData.unit,
      points: patrimonioDailyData.patrimonio,
    };
  }, [patrimonioIsDaily, patrimonioDailyData, ts?.patrimonio_usd_milestones_chart]);

  /** Union of retirement + brokerage group monthly Δ; YTD and cumulative on combined monthly Δ. */
  const retirementBrokeragePerfPoints = useMemo(() => {
    const retPts = retirementPerf?.points ?? [];
    const brkPts = brokeragePerf?.points ?? [];
    if (!retPts.length && !brkPts.length) return [];

    const deltaTotal = (p: Record<string, string | number | null>) => {
      const v = p.delta_total;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };

    const byDate = new Map<string, { ret: number; brk: number }>();
    for (const p of retPts) {
      const d = String(p.as_of_date ?? "");
      if (!d) continue;
      const cur = byDate.get(d) ?? { ret: 0, brk: 0 };
      cur.ret = deltaTotal(p);
      byDate.set(d, cur);
    }
    for (const p of brkPts) {
      const d = String(p.as_of_date ?? "");
      if (!d) continue;
      const cur = byDate.get(d) ?? { ret: 0, brk: 0 };
      cur.brk = deltaTotal(p);
      byDate.set(d, cur);
    }

    const datesAsc = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
    let ytdYear = 0;
    let ytdRun = 0;
    let cumLife = 0;
    const out: Record<string, string | number | null>[] = [];
    for (const d of datesAsc) {
      const { ret, brk } = byDate.get(d)!;
      const combined = ret + brk;
      const y = Number(d.slice(0, 4));
      if (Number.isFinite(y) && y !== ytdYear) {
        ytdYear = y;
        ytdRun = 0;
      }
      ytdRun += combined;
      cumLife += combined;
      out.push({
        as_of_date: d,
        delta_retirement: ret,
        delta_brokerage: brk,
        delta_combined: combined,
        ytd_combined: ytdRun,
        accumulated_earnings: cumLife,
      });
    }
    return out;
  }, [retirementPerf, brokeragePerf]);

  const retirementBrokerageForCharts = useMemo(() => {
    if (!retirementBrokeragePerfPoints.length) return [];
    if (!isYearly) return retirementBrokeragePerfPoints;
    // Months cut at the combos' Rango first, then rolled up: a partial first year.
    return clipMonthsThenRollup(
      retirementBrokeragePerfPoints,
      "year",
      combosPrefs.range,
      rollupCombinedPerfYearly
    );
  }, [retirementBrokeragePerfPoints, isYearly, combosPrefs.range]);

  // Day mode P/L bars: the two invested buckets' own daily series (shared `pg:` builds, warm
  // from their group pages). Synthetic bar accounts map them onto the monthly chart's keys.
  const retirementDaily = useDailySeries(
    { portfolioGroup: "retirement" },
    displayUnit,
    timeRangeToDays(combosPrefs.range),
    combosIsDaily
  );
  const brokerageDaily = useDailySeries(
    { portfolioGroup: "brokerage" },
    displayUnit,
    timeRangeToDays(combosPrefs.range),
    combosIsDaily
  );
  const combosLoading =
    contentLoading ||
    dailyLoading(combosIsDaily, retirementDaily) ||
    dailyLoading(combosIsDaily, brokerageDaily);
  const dailyRetirementBrokeragePoints = useMemo(() => {
    if (!combosIsDaily) return null;
    const ret = retirementDaily.data;
    const brk = brokerageDaily.data;
    if (!ret?.points.length || !brk?.points.length) return null;
    // Both series run the same calendar grid (same `days`, same today); bail rather than
    // mis-align if that ever stops holding.
    if (ret.points.length !== brk.points.length) return null;
    const depositsPerDay = (s: typeof ret): number[] => {
      const cum = s.deposits_acum_total;
      if (!cum?.length) return s.points.map(() => 0);
      return cum.map((v, i) => (i === 0 ? 0 : v - (cum[i - 1] ?? 0)));
    };
    const retDeps = depositsPerDay(ret);
    const brkDeps = depositsPerDay(brk);
    const rows = buildDailyPerfComboPoints({
      series: ret,
      lines: [
        { account_id: -1, name: "retirement", values: [], pl: ret.points.map((p) => p.pl) },
        { account_id: -2, name: "brokerage", values: [], pl: brk.points.map((p) => p.pl) },
      ],
      barAccounts: [
        { account_id: -1, bar_data_key: "delta_retirement" },
        { account_id: -2, bar_data_key: "delta_brokerage" },
      ],
      monthlyPointsAsc: retirementBrokeragePerfPoints,
      ytdKey: "ytd_combined",
      totalKey: "delta_combined",
    });
    return rows.map((row, i) => ({
      ...row,
      deposits_inversiones: (retDeps[i] ?? 0) + (brkDeps[i] ?? 0),
    }));
  }, [combosIsDaily, retirementDaily.data, brokerageDaily.data, retirementBrokeragePerfPoints]);

  const retirementBrokerageAccumChart = useMemo(() => {
    const depChart = dash?.inversiones_deposits_chart;
    const monthlyDeposits = !depChart
      ? []
      : showUsd && depChart.monthly_usd
        ? depChart.monthly_usd
        : depChart.monthly_clp;
    if (!isYearly) {
      // The chart clips the months; the MA3 trails the full history.
      return withInversionesMovingAverages(
        withInversionesDeposits(retirementBrokerageForCharts, monthlyDeposits)
      );
    }
    // Yearly: the deposits companion goes through the same months-then-rollup order as the P/L
    // rows (a partial first year), while the MA3 trails the FULL-history years — a partial first
    // year must not drag it, and the first visible years keep their trailing context, as in the
    // monthly view.
    const plotted = withInversionesDeposits(
      retirementBrokerageForCharts,
      clipMonthsThenRollup(monthlyDeposits, "year", combosPrefs.range, rollupDepositedByYear)
    );
    const fullYears = withInversionesMovingAverages(
      withInversionesDeposits(
        rollupCombinedPerfYearly(retirementBrokeragePerfPoints),
        rollupDepositedByYear(monthlyDeposits)
      )
    );
    const maByDate = new Map(fullYears.map((row) => [String(row.as_of_date ?? ""), row]));
    return plotted.map((row) => {
      const ma = maByDate.get(String(row.as_of_date ?? ""));
      return {
        ...row,
        delta_combined_ma3: ma?.delta_combined_ma3 ?? null,
        deposits_inversiones_ma3: ma?.deposits_inversiones_ma3 ?? null,
      };
    });
  }, [
    retirementBrokerageForCharts,
    retirementBrokeragePerfPoints,
    dash?.inversiones_deposits_chart,
    isYearly,
    showUsd,
    combosPrefs.range,
  ]);

  // Each valuation chart rolls up (or not) per its OWN period control.
  const overviewBlock = useMemo((): TimeseriesBlock | null => {
    if (!ts?.overview) return null;
    const base = { lines: ts.overview.lines, points: ts.overview.points };
    if (overviewPrefs.period !== "year") return base;
    return { lines: ts.overview.lines, points: rollupTimeseriesBlockYearEnd(base).points };
  }, [ts?.overview, overviewPrefs.period]);

  const principalesBlock = useMemo(() => {
    if (!ts?.accounts_ex_property) return null;
    return principalesPrefs.period === "year"
      ? rollupTimeseriesBlockYearEnd(ts.accounts_ex_property)
      : ts.accounts_ex_property;
  }, [ts?.accounts_ex_property, principalesPrefs.period]);

  const patrimonioBlock = useMemo(() => {
    const src = ts?.patrimonio_usd_milestones_chart;
    if (!src) return null;
    return patrimonioPrefs.period === "year"
      ? { ...rollupTimeseriesBlockYearEnd(src), unit: src.unit }
      : src;
  }, [ts?.patrimonio_usd_milestones_chart, patrimonioPrefs.period]);
  // The block carries its own unit: a held prior-unit block keeps rendering in that unit until
  // the new one lands (the zero placeholder has none and takes the toggle's).
  const patrimonioShown = dailyPatrimonioBlock ?? patrimonioBlock;
  const patrimonioUnit: DisplayUnit =
    patrimonioShown?.unit === "usd" || patrimonioShown?.unit === "clp"
      ? patrimonioShown.unit
      : displayUnit;

  const bucketColorBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of dash?.allocation ?? []) {
      m.set(row.group_slug, allocationBucketColor(row.group_slug, row.color_rgb));
    }
    return m;
  }, [dash?.allocation]);

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

  // The three P/L combo charts share ONE control (`home.combos`) — same state, rendered on each title.
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

      {patrimonioBlock?.points.length ? (
        <>
          <div className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
            <LineChartPanel
              title={t("dashboard.sections.netWorthUsdChartTitle")}
              block={patrimonioShown!}
              displayUnit={patrimonioUnit}
              includeAccumulatedLines={false}
              trimLeadingInactive={false}
              colorPlan={{ kind: "dashboard-patrimonio-usd" }}
              thickKey="total_nw"
              xAxisGranularity={
                dailyPatrimonioBlock ? "day" : patrimonioPrefs.period === "year" ? "year" : "month"
              }
              timeRange={patrimonioPrefs.range}
              controls={
                <SurfaceControls
                  period={patrimonioPrefs.period}
                  onPeriodChange={patrimonioPrefs.setPeriod}
                  range={patrimonioPrefs.range}
                  onRangeChange={patrimonioPrefs.setRange}
                />
              }
              yScaleDataKeys={["total_nw", "invested"]}
              loading={patrimonioLoading}
            />
          </div>
        </>
      ) : null}

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
              controls={combosControls}
              barSeries={[
                {
                  dataKey: "delta_retirement",
                  name: isYearly
                    ? t("dashboard.sections.deltaRetirementYearly")
                    : t("dashboard.sections.deltaRetirementMonthly"),
                  color: bucketColorBySlug.get("retirement") ?? allocationBucketColor("retirement"),
                },
                {
                  dataKey: "delta_brokerage",
                  name: isYearly
                    ? t("dashboard.sections.deltaBrokerageYearly")
                    : t("dashboard.sections.deltaBrokerageMonthly"),
                  color: bucketColorBySlug.get("brokerage") ?? allocationBucketColor("brokerage"),
                },
              ]}
              areaKey="ytd_combined"
              areaName={isYearly ? t("dashboard.sections.yearTotalCombined") : t("dashboard.sections.ytdCombined")}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              lineKey="delta_combined"
              lineName={isYearly ? t("dashboard.combinedAnnualDelta") : t("dashboard.combinedMonthlyDelta")}
              loading={combosLoading}
            />
          </div>
          <div className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
            <MonthlyPerformanceComboChart
              title={
                isYearly
                  ? t("dashboard.sections.accumEarningsChartTitleYearly")
                  : t("dashboard.sections.accumEarningsChartTitleMonthly")
              }
              points={dailyRetirementBrokeragePoints ?? retirementBrokerageAccumChart}
              displayUnit={displayUnit}
              xAxisGranularity={combosXAxis}
              timeRange={combosPrefs.range}
              controls={combosControls}
              barSeries={[
                {
                  dataKey: "delta_combined",
                  name: isYearly
                    ? t("dashboard.sections.deltaCombinedYearly")
                    : t("dashboard.sections.deltaCombinedMonthly"),
                  color: "#38bdf8",
                },
              ]}
              areaKey="accumulated_earnings"
              areaName={t("dashboard.sections.accumulatedEarnings")}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes={false}
              loading={combosLoading}
              lineSeries={dailyRetirementBrokeragePoints ? [] : [
                {
                  dataKey: "delta_combined_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DeltaCombinedYearly")
                    : t("dashboard.sections.ma3DeltaCombinedMonthly"),
                  stroke: "#0ea5e9",
                  strokeWidth: 1.5,
                  showDot: false,
                  pairsWithBar: "delta_combined",
                },
              ]}
            />
            <MonthlyPerformanceComboChart
              title={
                isYearly
                  ? t("dashboard.sections.accumFlowsChartTitleYearly")
                  : t("dashboard.sections.accumFlowsChartTitleMonthly")
              }
              points={dailyRetirementBrokeragePoints ?? retirementBrokerageAccumChart}
              displayUnit={displayUnit}
              xAxisGranularity={combosXAxis}
              timeRange={combosPrefs.range}
              controls={combosControls}
              loading={combosLoading}
              barSeries={[
                {
                  dataKey: "delta_combined",
                  name: isYearly
                    ? t("dashboard.sections.deltaCombinedYearly")
                    : t("dashboard.sections.deltaCombinedMonthly"),
                  color: "#38bdf8",
                },
                {
                  dataKey: "deposits_inversiones",
                  name: isYearly
                    ? t("dashboard.sections.depositsInversionesYearly")
                    : t("dashboard.sections.depositsInversionesMonthly"),
                  color: "#a78bfa",
                },
              ]}
              lineSeries={dailyRetirementBrokeragePoints ? [] : [
                {
                  dataKey: "delta_combined_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DeltaCombinedYearly")
                    : t("dashboard.sections.ma3DeltaCombinedMonthly"),
                  stroke: "#0ea5e9",
                  strokeWidth: 1.5,
                  showDot: false,
                  pairsWithBar: "delta_combined",
                },
                {
                  dataKey: "deposits_inversiones_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DepositsInversionesYearly")
                    : t("dashboard.sections.ma3DepositsInversionesMonthly"),
                  stroke: "#8b5cf6",
                  strokeWidth: 1.5,
                  showDot: false,
                  pairsWithBar: "deposits_inversiones",
                },
              ]}
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
              showUsd,
              animated: !unitSwitching,
            }
          : null
      }
      coldStripShape={DASHBOARD_COLD_STRIP}
      charts={dashboardCharts}
      tableAccounts={netWorthTableAccounts}
      serverPaginatedMonthlyDetail
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
