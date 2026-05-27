import { useEffect, useMemo } from "react";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { LineChartPanel, ValuationLineCharts } from "../components/charts/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/charts/MonthlyPerformanceComboChart";
import { GroupInfoNavHierarchyTable } from "../components/group/GroupInfoNavHierarchyTable";
import { GroupInfoBase } from "../components/group/GroupInfoBase";
import { useDashboardBundle } from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { allocationBucketColor } from "../chartColors";
import { appendTrailingMovingAverage } from "../chartMovingAverage";
import {
  rollupRetirementBrokeragePerfYearly,
  rollupTimeseriesBlockYearEnd,
} from "../dashboardTimeseriesYearly";
import { useLoading } from "../context/LoadingContext";
import { useTranslation } from "../i18n";
import { navColorTargetFromDto, resolveNetWorthGroupLabel } from "../sidebarNavFromApi";
import { useSidebarNav } from "../queries/hooks";
import { formatMoneyForPie } from "../format";
import {
  dashboardAccountsForNavHierarchy,
  isDashboardNwBucketSlug,
  netWorthTableAccountsFromDash,
} from "../portfolioDashboardBuckets";
import type { ValuationTimeseriesResponse } from "../types";

export function DashboardPage() {
  const { t } = useTranslation();
  const { setLoading } = useLoading();
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const { data: sidebarNav } = useSidebarNav();
  const pageTitle = resolveNetWorthGroupLabel(sidebarNav);
  const netWorthNav = sidebarNav?.net_worth ?? null;
  const netWorthColorTarget = netWorthNav ? navColorTargetFromDto(netWorthNav) : undefined;
  const { data, error, isPending, isFetching, isPlaceholderData } = useDashboardBundle(displayUnit);

  const dash = data?.dash ?? null;
  const ts = data?.ts ?? null;
  const retirementPerf = data?.retirementPerf ?? null;
  const brokeragePerf = data?.brokeragePerf ?? null;
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const showUsd = displayUnit === "usd";
  const unitSwitching = isFetching && (isPlaceholderData || !isPending);
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";

  useEffect(() => {
    setLoading(isPending && data === undefined);
    return () => setLoading(false);
  }, [isPending, data, setLoading]);

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
    return rollupRetirementBrokeragePerfYearly(retirementBrokeragePerfPoints);
  }, [retirementBrokeragePerfPoints, isYearly]);

  const retirementBrokerageAccumChart = useMemo(() => {
    const depChart = dash?.inversiones_deposits_chart;
    const depositSeries = !depChart
      ? []
      : isYearly
        ? showUsd && depChart.yearly_usd
          ? depChart.yearly_usd
          : depChart.yearly_clp
        : showUsd && depChart.monthly_usd
          ? depChart.monthly_usd
          : depChart.monthly_clp;
    const depByDate = new Map(depositSeries.map((p) => [p.as_of_date, p.deposited]));
    let rows: Record<string, string | number | null>[] = retirementBrokerageForCharts.map((row) => ({
      ...row,
      deposits_inversiones: depByDate.get(String(row.as_of_date ?? "")) ?? 0,
    }));
    rows = appendTrailingMovingAverage(rows, "delta_combined", "delta_combined_ma3");
    rows = appendTrailingMovingAverage(rows, "deposits_inversiones", "deposits_inversiones_ma3");
    return rows;
  }, [retirementBrokerageForCharts, dash?.inversiones_deposits_chart, isYearly, showUsd]);

  const tsForCharts = useMemo((): ValuationTimeseriesResponse | null => {
    if (!ts?.accounts_ex_property || !ts.overview) return ts;
    if (!isYearly) return ts;
    const overviewRolled = rollupTimeseriesBlockYearEnd({
      points: ts.overview.points,
      lines: ts.overview.lines,
    });
    const patrimonioRolled = ts.patrimonio_usd_milestones_chart
      ? rollupTimeseriesBlockYearEnd(ts.patrimonio_usd_milestones_chart)
      : undefined;
    return {
      ...ts,
      accounts_ex_property: rollupTimeseriesBlockYearEnd(ts.accounts_ex_property),
      overview: { lines: ts.overview.lines, points: overviewRolled.points },
      ...(patrimonioRolled ? { patrimonio_usd_milestones_chart: patrimonioRolled } : {}),
    };
  }, [ts, isYearly]);

  const bucketColorBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of dash?.allocation ?? []) {
      m.set(row.group_slug, allocationBucketColor(row.group_slug, row.color_rgb));
    }
    return m;
  }, [dash?.allocation]);

  const overviewPoints = ts?.overview?.points ?? [];

  const netWorthTableAccounts = useMemo(
    () => (dash ? netWorthTableAccountsFromDash(dash.accounts) : []),
    [dash]
  );

  const navHierarchyAccounts = useMemo(
    () => (dash ? dashboardAccountsForNavHierarchy(dash.accounts) : []),
    [dash]
  );

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!dash || !tsForCharts || !tsForCharts.accounts_ex_property || !tsForCharts.overview) {
    return null;
  }

  const useUsdPie =
    showUsd &&
    dash.allocation.some((a) => a.value_usd != null && Number.isFinite(a.value_usd) && a.value_usd > 0);

  const pieData = dash.allocation
    .filter((a) => isDashboardNwBucketSlug(a.group_slug))
    .map((a) => ({
      name: a.group_label,
      value: useUsdPie && a.value_usd != null ? a.value_usd : a.value_clp,
      group_slug: a.group_slug,
    }));

  const dashboardCharts = (
    <>
      <ValuationLineCharts
        displayUnit={displayUnit}
        primaryTitle={t("dashboard.sections.overviewTitle")}
        primary={{ lines: tsForCharts.overview.lines, points: tsForCharts.overview.points }}
        secondaryTitle={t("dashboard.sections.primaryAccountsTitle")}
        secondary={tsForCharts.accounts_ex_property}
        thickLineDataKey="total_nw"
        includeAccumulatedLines={false}
        primaryColorPlan={{ kind: "dashboard-overview" }}
        secondaryColorPlan={{ kind: "dashboard-primary" }}
        xAxisGranularity={xAxisGranularity}
        chartLayout="fullWidthStack"
      />

      {tsForCharts.patrimonio_usd_milestones_chart?.points.length ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>{t("dashboard.sections.netWorthUsdSectionTitle")}</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {t("dashboard.sections.netWorthUsdSectionHint")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <LineChartPanel
              title={t("dashboard.sections.netWorthUsdChartTitle")}
              titleAs="h3"
              block={tsForCharts.patrimonio_usd_milestones_chart}
              displayUnit="clp"
              includeAccumulatedLines={false}
              trimLeadingInactive={false}
              colorPlan={{ kind: "dashboard-patrimonio-usd" }}
              thickKey="total_nw"
              xAxisGranularity={xAxisGranularity}
              yScaleDataKeys={["total_nw", "invested"]}
            />
          </div>
        </>
      ) : null}

      {retirementBrokerageForCharts.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>
            {isYearly ? t("dashboard.sections.perfSectionTitleYearly") : t("dashboard.sections.perfSectionTitleMonthly")}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {isYearly ? t("dashboard.sections.perfSectionHintYearly") : t("dashboard.sections.perfSectionHintMonthly")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                isYearly ? t("dashboard.sections.perfChartTitleYearly") : t("dashboard.sections.perfChartTitleMonthly")
              }
              titleAs="h3"
              points={retirementBrokerageForCharts}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
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
            />
          </div>
          <h2 style={{ marginTop: "1.75rem" }}>
            {isYearly ? t("dashboard.sections.accumSectionTitleYearly") : t("dashboard.sections.accumSectionTitleMonthly")}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {isYearly ? t("dashboard.sections.accumSectionHintYearly") : t("dashboard.sections.accumSectionHintMonthly")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                isYearly ? t("dashboard.sections.accumChartTitleYearly") : t("dashboard.sections.accumChartTitleMonthly")
              }
              titleAs="h3"
              points={retirementBrokerageAccumChart}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
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
              areaKey="accumulated_earnings"
              areaName={t("dashboard.sections.accumulatedEarnings")}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes={false}
              lineSeries={[
                {
                  dataKey: "delta_combined_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DeltaCombinedYearly")
                    : t("dashboard.sections.ma3DeltaCombinedMonthly"),
                  stroke: "#38bdf8",
                  strokeWidth: 1.5,
                  showDot: false,
                },
                {
                  dataKey: "deposits_inversiones_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DepositsInversionesYearly")
                    : t("dashboard.sections.ma3DepositsInversionesMonthly"),
                  stroke: "#a78bfa",
                  strokeWidth: 1.5,
                  showDot: false,
                },
              ]}
            />
          </div>
        </>
      ) : null}

      <h2>{t("dashboard.allocation.title")}</h2>
      {pieData.length === 0 ? (
        <p className="empty">{t("dashboard.allocation.empty")}</p>
      ) : (
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 32, right: 4, left: 4, bottom: 0 }}>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={(p: { value?: unknown }) => {
                  const v = typeof p.value === "number" ? p.value : Number(p.value);
                  return formatMoneyForPie(Number.isFinite(v) ? v : 0, useUsdPie ? "usd" : "clp");
                }}
                isAnimationActive
                animationBegin={0}
                animationDuration={90}
                animationEasing="ease-out"
              >
                {pieData.map((row, i) => (
                  <Cell
                    key={i}
                    fill={
                      bucketColorBySlug.get(row.group_slug) ?? allocationBucketColor(row.group_slug)
                    }
                  />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => formatMoneyForPie(v, useUsdPie ? "usd" : "clp")}
              />
              <Legend formatter={(value) => String(value ?? "")} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );

  return (
    <GroupInfoBase
      mainClassName="page-dashboard"
      title={pageTitle}
      colorRgb={netWorthNav?.color_rgb}
      colorTarget={netWorthColorTarget}
      portfolio={
        netWorthNav
          ? {
              navNode: netWorthNav,
              dash,
              overviewPoints,
              metricsPeriod,
              showUsd,
              animated: !unitSwitching,
            }
          : null
      }
      charts={dashboardCharts}
      tableAccounts={netWorthTableAccounts}
      monthlyDetailHint={t("dashboard.monthlyDetailHint")}
      flowsHint={t("dashboard.flowsHint")}
      accountsTree={
        netWorthNav ? (
          <GroupInfoNavHierarchyTable
            rootNode={netWorthNav}
            accounts={navHierarchyAccounts}
            titleI18nKey="dashboard.accountsTreeTitle"
            emptyI18nKey="dashboard.accountsTreeEmpty"
          />
        ) : null
      }
    />
  );
}
