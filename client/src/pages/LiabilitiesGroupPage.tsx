import { useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { AllocationPiePanel, LineChartPanel } from "../components/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { GroupInfoNavHierarchyTable } from "../components/GroupInfoNavHierarchyTable";
import { GroupInfoBase } from "../components/GroupInfoBase";
import { filterTimeseriesBlockByAccountIds } from "../filterTimeseriesBlock";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayPieSlices,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import {
  allocationBucketColor,
  buildGroupTabColorMaps,
  groupTabPieSliceFill,
} from "../chartColors";
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "../dashboardTimeseriesYearly";
import { liabilitiesChartBucketNavNodes } from "../liabilitiesChartBuckets";
import { parseLiabilitiesSubgroupParam } from "../liabilitiesPath";
import { navAccountIdSet } from "../portfolioNavDashboardCards";
import { findLiabilitiesNavNodeForPathname } from "../portfolioNavFromApi";
import { navColorTargetFromDto, resolveNavTreeLabel } from "../sidebarNavFromApi";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import {
  useDashboardBundle,
  usePortfolioGroupBundle,
  useSidebarNav,
} from "../queries/hooks";
import type { GroupMonthlyPerformanceResponse } from "../types";

function filterGroupPerfByAccountIds(
  perf: GroupMonthlyPerformanceResponse | null,
  accountIds: Set<number>
): GroupMonthlyPerformanceResponse | null {
  if (!perf?.points.length) return perf;
  const bars = perf.bar_accounts.filter((b) => accountIds.has(b.account_id));
  if (!bars.length) return { ...perf, bar_accounts: [], points: perf.points };
  const barKeys = new Set(bars.map((b) => b.bar_data_key));
  const points = perf.points.map((row) => {
    const out: Record<string, string | number | null> = {
      as_of_date: row.as_of_date,
      delta_total: row.delta_total,
      ytd_group: row.ytd_group,
      accumulated_earnings: row.accumulated_earnings,
    };
    for (const k of barKeys) {
      if (k in row) out[k] = row[k] ?? null;
    }
    return out;
  });
  return { ...perf, bar_accounts: bars, points };
}

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
  const { data: dashBundle } = useDashboardBundle(displayUnit);
  const dash = dashBundle?.dash ?? null;
  const overviewPoints = dashBundle?.ts?.overview?.points ?? [];

  const navMatchNode = useMemo(
    () =>
      findLiabilitiesNavNodeForPathname(
        sidebarNav?.main,
        pathname,
        categoryFilter ?? undefined
      ),
    [sidebarNav, pathname, categoryFilter]
  );

  const { data, error } = usePortfolioGroupBundle({
    group: "liabilities",
    subgroup: categoryFilter ?? undefined,
    unit: displayUnit,
    enabled: Boolean(navMatchNode),
  });

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode) : null),
    [navMatchNode]
  );

  const accounts = data?.accounts ?? [];

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

  const ts = data?.ts ?? null;
  const groupPerfRaw = data?.groupPerf ?? null;

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

  const valuationBlockForChart = useMemo(() => {
    if (!displayValuationBlock) return null;
    if (!isYearly) return displayValuationBlock;
    return rollupTimeseriesBlockYearEnd(displayValuationBlock);
  }, [displayValuationBlock, isYearly]);

  const groupPerfForChart = useMemo(() => {
    if (!displayGroupPerf?.points.length) return displayGroupPerf;
    if (!isYearly) return displayGroupPerf;
    const barKeys = displayGroupPerf.bar_accounts.map((a) => a.bar_data_key);
    return {
      ...displayGroupPerf,
      points: rollupPerfPointsYearly(displayGroupPerf.points, {
        sumKeys: barKeys,
        ytdKey: "ytd_group",
        accumKey: "accumulated_earnings",
        totalKey: "delta_total",
      }),
    };
  }, [displayGroupPerf, isYearly]);

  const groupColorMaps = useMemo(() => {
    const accLines = displayValuationBlock?.accounts;
    if (!accLines?.length) {
      return { byDataKey: new Map<string, string>(), byAccountId: new Map<number, string>() };
    }
    return buildGroupTabColorMaps("liabilities", accLines);
  }, [displayValuationBlock]);

  const groupPerfBarSeries = useMemo(() => {
    if (!displayGroupPerf?.bar_accounts.length) return [];
    const lines = displayGroupPerf.bar_accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      dataKey: a.bar_data_key,
      color_rgb: a.color_rgb,
    }));
    const maps = buildGroupTabColorMaps("liabilities", lines);
    return displayGroupPerf.bar_accounts.map((a) => ({
      dataKey: a.bar_data_key,
      name: `Δ ${a.name}`,
      color:
        groupColorMaps.byAccountId.get(a.account_id) ??
        maps.byDataKey.get(a.bar_data_key) ??
        "#60a5fa",
    }));
  }, [displayGroupPerf, groupColorMaps]);

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

  if (!ts?.accounts_in_group || !ts.group_allocation_pie) {
    return (
      <main>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  const charts = (
    <>
      {accounts.length === 0 ? (
        <p className="empty muted" style={{ marginTop: "1rem" }}>
          {t("groupPage.accountsTreeEmpty")}
        </p>
      ) : (
        <div
          className={cn("chart-grid", chartSeriesCount <= 1 && "chart-grid--full-line")}
          style={{ marginTop: "0.75rem" }}
        >
          <LineChartPanel
            title="Valorización y aportes"
            block={valuationBlockForChart!}
            displayUnit={displayUnit}
            xAxisGranularity={xAxisGranularity}
            includeAccumulatedLines
            colorPlan={{
              kind: "group-tab",
              groupSlug: "liabilities",
              accounts: valuationBlockForChart!.accounts ?? [],
            }}
            thickKey={
              valuationBlockForChart!.accounts?.some((a) => a.dataKey === "__group_val_total")
                ? "__group_val_total"
                : undefined
            }
          />
          {chartSeriesCount > 1 && (
            <AllocationPiePanel
              title="Valor actual por cuenta"
              slices={displayPieSlices}
              displayUnit={displayUnit}
              sliceFill={(slice) =>
                groupTabPieSliceFill("liabilities", groupColorMaps, slice.account_id, {
                  allocationBucketSlug: "liabilities",
                })
              }
            />
          )}
        </div>
      )}

      {accounts.length > 0 &&
        groupPerfForChart &&
        groupPerfForChart.points.length > 0 &&
        groupPerfBarSeries.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem", fontSize: "1.15rem" }}>P/L mensual — YTD (grupo)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            Barras por cuenta o subgrupo, área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes.
            Derivado.
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title="Δ por cuenta / subgrupo, YTD combinado y Δ total"
              points={groupPerfForChart.points}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={groupPerfBarSeries}
              areaKey="ytd_group"
              areaName="YTD (grupo)"
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              lineKey="delta_total"
              lineName="Δ total"
            />
          </div>
          <h2 style={{ marginTop: "1.75rem", fontSize: "1.15rem" }}>Accumulated earnings (grupo)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            Una barra = suma mensual de la clase. Área continua (sin franjas por año). Desde el primer mes con datos.
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title="Monthly Δ (consolidado) y accumulated earnings"
              points={groupPerfForChart.points}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_total",
                  name: "Monthly Δ (consolidated)",
                  color: allocationBucketColor("liabilities"),
                },
              ]}
              areaKey="accumulated_earnings"
              areaName="Accumulated earnings"
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes={false}
            />
          </div>
        </>
      ) : null}
    </>
  );

  return (
    <GroupInfoBase
      title={title}
      colorRgb={navMatchNode.color_rgb}
      colorTarget={pageColorTarget}
      portfolio={
        dash && displayValuationBlock && accounts.length > 0
          ? {
              navNode: navMatchNode,
              dash,
              overviewPoints,
              metricsPeriod,
              showUsd,
              animated: true,
            }
          : null
      }
      charts={charts}
      tableAccounts={tableAccountsForPerf}
      monthlyDetailHint={t("groupPage.monthlyDetailHintLiabilities")}
      flowsHint={t("groupPage.flowsHintLiabilities")}
      accountsTree={
        <GroupInfoNavHierarchyTable
          rootNode={navMatchNode}
          accounts={accounts}
          titleI18nKey="groupPage.accountsTreeTitleLiabilities"
        />
      }
    />
  );
}
