import { useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { GroupInfoNavHierarchyTable } from "../components/GroupInfoNavHierarchyTable";
import { GroupInfoBase } from "../components/GroupInfoBase";
import { PortfolioGroupChartsSection } from "../components/PortfolioGroupChartsSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildDisplayGroupPerf,
  buildDisplayPieSlices,
  buildDisplayValuationBlock,
  resolveGroupPageChartContext,
} from "../groupPageChartViews";
import type { AssetGroupSlug } from "../types";
import { navAccountIdSet } from "../portfolioNavDashboardCards";
import { findBestNavNodeForPathname } from "../portfolioNavFromApi";
import { navColorTargetFromDto, resolveNavTreeLabel } from "../sidebarNavFromApi";
import { usePortfolioGroupCharts } from "../usePortfolioGroupCharts";
import { useTranslation } from "../i18n";
import {
  useDashboardBundle,
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
  const { data: dashBundle } = useDashboardBundle(displayUnit);
  const dash = dashBundle?.dash ?? null;
  const overviewPoints = dashBundle?.ts?.overview?.points ?? [];

  const navMatchNode = useMemo(
    () => findBestNavNodeForPathname(sidebarNav?.main, pathname),
    [sidebarNav, pathname]
  );

  const apiGroup = navMatchNode?.api_group ?? navMatchNode?.asset_group_slug ?? "";
  const apiSubgroup = navMatchNode?.api_subgroup ?? undefined;

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

  const accounts = data?.accounts ?? [];

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
  const chartColorSlug = (chartCtx?.chartColorSlug ?? apiGroup) as AssetGroupSlug | "crypto";
  const pieAllocationSlug = (chartCtx?.pieAllocationSlug ?? apiGroup) as AssetGroupSlug;

  const charts = usePortfolioGroupCharts({
    displayValuationBlock,
    displayGroupPerf,
    isYearly,
    chartColorSlug,
    pieAllocationSlug,
    colorPlanGroupSlug: chartCtx?.colorPlanGroupSlug ?? "inversiones",
  });

  const title = navMatchNode ? resolveNavTreeLabel(navMatchNode) : "";
  const pageColorTarget = navMatchNode ? navColorTargetFromDto(navMatchNode) : undefined;
  const showUsd = displayUnit === "usd";
  const err = error instanceof Error ? error.message : error ? "Failed to load" : null;

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

  const isRealEstate = navMatchNode.asset_group_slug === "real_estate";

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
      portfolio={
        dash && charts.valuationBlockForChart && accounts.length > 0
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
          accountsEmptyMessage="No hay cuentas en esta vista todavía."
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
          consolidatedBarColor={charts.consolidatedBarColor}
          chartCtx={chartCtx}
          showValuationDeposits={showValuationDeposits}
        />
      }
      tableAccounts={tableAccountsForPerf}
      accountsTree={
        <GroupInfoNavHierarchyTable rootNode={navMatchNode} accounts={accounts} />
      }
    />
  );
}
