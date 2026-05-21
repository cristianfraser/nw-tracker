import { useMemo, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { AllocationPiePanel, LineChartPanel } from "../components/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { GroupInfoNavHierarchyTable } from "../components/GroupInfoNavHierarchyTable";
import { GroupInfoBase } from "../components/GroupInfoBase";
import { PortfolioNavEntityCardsStrip } from "../components/PortfolioNavEntityCardsStrip";
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
import type { AssetGroupSlug } from "../types";
import { parseLiabilitiesSubgroupParam } from "../liabilitiesPath";
import {
  navAccountIdSet,
  portfolioNavParentTitleModeForNavNode,
} from "../portfolioNavDashboardCards";
import { findBestNavNodeForPathname, navHierarchyTableChildren } from "../portfolioNavFromApi";
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

/** Portfolio / asset-class group page: shared shell via {@link GroupInfoBase}, group-specific charts. */
export function GroupInfoPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { subgroup: liabilitiesSubgroupParam } = useParams();
  const liabilitiesCategory = useMemo(
    () => parseLiabilitiesSubgroupParam(liabilitiesSubgroupParam),
    [liabilitiesSubgroupParam]
  );

  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav();
  const navStillLoading = (navPending || navFetching) && sidebarNav == null;
  const { data: dashBundle } = useDashboardBundle(displayUnit);
  const dash = dashBundle?.dash ?? null;
  const overviewPoints = dashBundle?.ts?.overview?.points ?? [];

  const navMatchNode = useMemo(
    () => findBestNavNodeForPathname(sidebarNav?.main, pathname),
    [sidebarNav, pathname]
  );

  const apiGroup = navMatchNode?.api_group ?? navMatchNode?.asset_group_slug ?? "";
  const apiSubgroup =
    liabilitiesCategory ?? (apiGroup === "liabilities" ? undefined : navMatchNode?.api_subgroup ?? undefined);

  const { data, error } = usePortfolioGroupBundle({
    group: apiGroup,
    subgroup: apiSubgroup,
    unit: displayUnit,
    enabled: Boolean(navMatchNode && apiGroup),
  });

  const [invRootGrouped, setInvRootGrouped] = useState(true);
  const [retiroGrouped, setRetiroGrouped] = useState(true);
  const [brokerageGroupedAll, setBrokerageGroupedAll] = useState(true);
  const [apvGrouped, setApvGrouped] = useState(true);
  const [showValuationDeposits, setShowValuationDeposits] = useState(true);

  const chartCtx = useMemo(
    () => (navMatchNode ? resolveGroupPageChartContext(navMatchNode) : null),
    [navMatchNode]
  );

  const groupedToggleOn = chartCtx
    ? chartCtx.rootInvTodas
      ? invRootGrouped
      : chartCtx.apvTodas
        ? apvGrouped
        : chartCtx.retiroTodas
          ? retiroGrouped
          : chartCtx.brokerageTodas
            ? brokerageGroupedAll
            : false
    : false;

  const allAccounts = data?.accounts ?? [];
  const accounts = useMemo(() => {
    if (!liabilitiesCategory) return allAccounts;
    return allAccounts.filter((a) => a.category_slug === liabilitiesCategory);
  }, [allAccounts, liabilitiesCategory]);

  const chartAccountIds = useMemo(() => {
    if (navMatchNode) return navAccountIdSet(navMatchNode);
    return new Set(accounts.map((a) => a.id));
  }, [navMatchNode, accounts]);

  const tableAccounts = useMemo(
    () => accounts.filter((a) => chartAccountIds.has(a.id)),
    [accounts, chartAccountIds]
  );

  const tableAccountsForPerf = useMemo(
    () =>
      tableAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        category_slug: a.category_slug,
      })),
    [tableAccounts]
  );

  const ts = data?.ts ?? null;
  const groupPerfRaw = data?.groupPerf ?? null;

  const displayValuationBlock = useMemo(() => {
    if (!ts?.accounts_in_group || !chartCtx) return null;
    let block = buildDisplayValuationBlock(ts, accounts, chartCtx, groupedToggleOn);
    if (!block) return null;
    if (liabilitiesCategory) {
      block = filterTimeseriesBlockByAccountIds(block, chartAccountIds);
    }
    return block;
  }, [ts, accounts, chartCtx, groupedToggleOn, liabilitiesCategory, chartAccountIds]);

  const displayPieSlices = useMemo(() => {
    if (!ts?.group_allocation_pie || !chartCtx) return [];
    return buildDisplayPieSlices(ts, accounts, chartCtx, groupedToggleOn);
  }, [ts, accounts, chartCtx, groupedToggleOn]);

  const displayGroupPerf = useMemo(() => {
    if (!chartCtx) return groupPerfRaw;
    const perf = buildDisplayGroupPerf(groupPerfRaw, accounts, chartCtx, groupedToggleOn);
    if (liabilitiesCategory) return filterGroupPerfByAccountIds(perf, chartAccountIds);
    return perf;
  }, [groupPerfRaw, accounts, chartCtx, groupedToggleOn, liabilitiesCategory, chartAccountIds]);

  const stripDetailChildren = useMemo(
    () => (navMatchNode ? navHierarchyTableChildren(navMatchNode) : []),
    [navMatchNode]
  );

  const chartColorSlug = (chartCtx?.chartColorSlug ?? apiGroup) as AssetGroupSlug | "crypto";
  const groupColorMaps = useMemo(() => {
    const accLines = displayValuationBlock?.accounts;
    if (!accLines?.length) {
      return { byDataKey: new Map<string, string>(), byAccountId: new Map<number, string>() };
    }
    return buildGroupTabColorMaps(chartColorSlug, accLines);
  }, [chartColorSlug, displayValuationBlock]);

  const groupPerfBarSeries = useMemo(() => {
    if (!displayGroupPerf?.bar_accounts.length) return [];
    const lines = displayGroupPerf.bar_accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      dataKey: a.bar_data_key,
      color_rgb: a.color_rgb,
    }));
    const maps = buildGroupTabColorMaps(chartColorSlug, lines);
    return displayGroupPerf.bar_accounts.map((a) => ({
      dataKey: a.bar_data_key,
      name: `Δ ${a.name}`,
      color:
        groupColorMaps.byAccountId.get(a.account_id) ??
        maps.byDataKey.get(a.bar_data_key) ??
        "#60a5fa",
    }));
  }, [chartColorSlug, displayGroupPerf, groupColorMaps]);

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const pageColorTarget = navMatchNode ? navColorTargetFromDto(navMatchNode) : undefined;
  const showUsd = displayUnit === "usd";
  const err = error instanceof Error ? error.message : error ? "Failed to load" : null;

  if (liabilitiesSubgroupParam != null && liabilitiesSubgroupParam !== "" && liabilitiesCategory === null) {
    return <Navigate to="/liabilities" replace />;
  }

  if (navStillLoading) {
    return (
      <main>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  if (!navMatchNode || !apiGroup) {
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

  const pieAllocationSlug = (chartCtx?.pieAllocationSlug ?? apiGroup) as AssetGroupSlug;
  const isRealEstate = navMatchNode.asset_group_slug === "real_estate";

  const charts = (
    <>
      {accounts.length === 0 ? (
        <p className="empty muted" style={{ marginTop: "1rem" }}>
          No hay cuentas en esta vista todavía.
        </p>
      ) : (
        <div
          className={cn("chart-grid", accounts.length <= 1 && "chart-grid--full-line")}
          style={{ marginTop: "0.75rem" }}
        >
          <LineChartPanel
            title="Valorización y aportes"
            block={displayValuationBlock!}
            displayUnit={displayUnit}
            includeAccumulatedLines={chartCtx?.showGroupedToggle ? showValuationDeposits : true}
            colorPlan={{
              kind: "group-tab",
              groupSlug: chartCtx?.colorPlanGroupSlug ?? "inversiones",
              brokerageSubgroup: chartCtx?.brokerageSubgroup,
              accounts: displayValuationBlock!.accounts ?? [],
            }}
            thickKey={
              displayValuationBlock!.accounts?.some((a) => a.dataKey === "__group_val_total")
                ? "__group_val_total"
                : undefined
            }
          />
          {accounts.length > 1 && (
            <AllocationPiePanel
              title="Valor actual por cuenta"
              slices={displayPieSlices}
              displayUnit={displayUnit}
              sliceFill={(slice) =>
                groupTabPieSliceFill(chartColorSlug, groupColorMaps, slice.account_id, {
                  allocationBucketSlug: pieAllocationSlug,
                })
              }
            />
          )}
        </div>
      )}

      {accounts.length > 0 &&
        displayGroupPerf &&
        displayGroupPerf.points.length > 0 &&
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
              points={displayGroupPerf.points}
              displayUnit={displayUnit}
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
              points={displayGroupPerf.points}
              displayUnit={displayUnit}
              barSeries={[
                {
                  dataKey: "delta_total",
                  name: "Monthly Δ (consolidated)",
                  color: allocationBucketColor(pieAllocationSlug as AssetGroupSlug),
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
      toolbar={
        chartCtx?.showGroupedToggle ? (
          <div className="toggle-row" style={{ flexWrap: "wrap", gap: "0.5rem 1rem" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
              <input
                type="checkbox"
                checked={groupedToggleOn}
                onChange={(e) => {
                  const v = e.target.checked;
                  if (chartCtx.rootInvTodas) setInvRootGrouped(v);
                  else if (chartCtx.apvTodas) setApvGrouped(v);
                  else if (chartCtx.retiroTodas) setRetiroGrouped(v);
                  else setBrokerageGroupedAll(v);
                }}
              />
              <span>Agrupado</span>
            </label>
            <label
              style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 12 }}
              title="Líneas punteadas de aportes acumulados por cuenta o grupo (misma escala que valorización)."
            >
              <input
                type="checkbox"
                checked={showValuationDeposits}
                onChange={(e) => setShowValuationDeposits(e.target.checked)}
              />
              <span>Aportes acumulados</span>
            </label>
          </div>
        ) : null
      }
      cards={
        dash && displayValuationBlock && accounts.length > 0 ? (
          <PortfolioNavEntityCardsStrip
            dash={dash}
            overviewPoints={overviewPoints}
            parentNavNode={navMatchNode}
            detailNavChildren={stripDetailChildren}
            compactTitle={title}
            compactCardSlug={`grp-nav-${navMatchNode.slug}-${navMatchNode.node_id}`}
            parentTitleMode={portfolioNavParentTitleModeForNavNode(navMatchNode)}
            showUsd={showUsd}
            metricsPeriod={metricsPeriod}
            animated
          />
        ) : null
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
      charts={charts}
      tableAccounts={tableAccountsForPerf}
      accountsTree={
        <GroupInfoNavHierarchyTable rootNode={navMatchNode} accounts={accounts} />
      }
    />
  );
}
