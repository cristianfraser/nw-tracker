import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { AllocationPiePanel, LineChartPanel } from "../components/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { Table } from "../components/Table";
import { api } from "../api";
import {
  aggregateBrokerageAllViewPerformance,
  aggregateBrokerageAllViewPie,
  aggregateBrokerageAllViewValuationBlock,
  BROKERAGE_GROUP_ORDER,
  brokeragePortfolioGroupFromCategorySlug,
  brokeragePortfolioGroupLabel,
  brokeragePortfolioGroupPath,
} from "../brokerageGroupedAggregation";
import {
  aggregateApvSubgroupGroupedPerformance,
  aggregateApvSubgroupGroupedPie,
  aggregateApvSubgroupGroupedValuationBlock,
  aggregateInversionesRootGroupedPerformance,
  aggregateInversionesRootGroupedPie,
  aggregateInversionesRootGroupedValuationBlock,
  aggregateInversionesRootUngroupedPerformance,
  aggregateInversionesRootUngroupedPie,
  aggregateInversionesRootUngroupedValuationBlock,
  aggregateRetiroGroupedPerformance,
  aggregateRetiroGroupedPie,
  aggregateRetiroGroupedValuationBlock,
} from "../inversionesGroupedAggregation";
import { allocationBucketColor, buildGroupTabColorMaps, groupTabPieSliceFill } from "../chartColors";
import i18n from "../i18n";
import { parseInversionesSplat, inversionesGroupParentBackLink } from "../inversionesPath";
import {
  brokerageAccountNavLabel,
  hideRedundantGroupRow,
  retirementAccountNavLabel,
} from "../navAccountLabels";
import type {
  AccountListRow,
  GroupMonthlyPerformanceResponse,
  ValuationTimeseriesResponse,
} from "../types";

type DisplayUnit = "clp" | "usd";

/** Parent row in “Grupos y cuentas” for AFP + AFC (cotización obligatoria). */
const RETIRO_AFP_AFC_GROUP_TITLE = "AFP + AFC";

function HierarchyNavRow({
  depth,
  isGroup,
  nameCell,
  categoryCell,
  groupCell,
  notesCell,
}: {
  depth: number;
  isGroup: boolean;
  nameCell: import("react").ReactNode;
  categoryCell: import("react").ReactNode;
  groupCell: import("react").ReactNode;
  notesCell: import("react").ReactNode;
}) {
  const pad = `calc(0.65rem + ${depth} * 1.15rem)`;
  return (
    <tr className={isGroup ? "hierarchy-nav-group" : "hierarchy-nav-leaf"}>
      <td
        style={{
          paddingLeft: pad,
          boxShadow: depth >= 1 && !isGroup ? "inset 3px 0 0 var(--border)" : undefined,
        }}
      >
        {nameCell}
      </td>
      <td>{categoryCell}</td>
      <td className="muted">{groupCell}</td>
      <td className="muted">{notesCell}</td>
    </tr>
  );
}

export function InversionesPage() {
  const { "*": splat } = useParams();
  const resolved = useMemo(() => parseInversionesSplat(splat), [splat]);
  const pathInvalid = resolved === null;

  const [accounts, setAccounts] = useState<AccountListRow[]>([]);
  const [navInv, setNavInv] = useState<AccountListRow[]>([]);
  const [navRet, setNavRet] = useState<AccountListRow[]>([]);
  const [navBrk, setNavBrk] = useState<AccountListRow[]>([]);
  const [ts, setTs] = useState<ValuationTimeseriesResponse | null>(null);
  const [groupPerf, setGroupPerf] = useState<GroupMonthlyPerformanceResponse | null>(null);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("clp");
  const [err, setErr] = useState<string | null>(null);
  const [brokerageGroupedAll, setBrokerageGroupedAll] = useState(true);
  const [invRootGrouped, setInvRootGrouped] = useState(true);
  const [retiroGrouped, setRetiroGrouped] = useState(true);
  /** APV class tab: régimen A vs B vs all accounts. */
  const [apvGrouped, setApvGrouped] = useState(true);
  /** Shown with “Agrupado”: toggles dashed “aportes acum.” lines on the valuation chart. */
  const [showValuationDeposits, setShowValuationDeposits] = useState(true);

  const brokerageTodas = Boolean(
    resolved && resolved.apiGroup === "brokerage" && resolved.apiSubgroup === undefined
  );
  const rootInvTodas = Boolean(
    resolved && resolved.apiGroup === "inversiones" && resolved.navScope === "root"
  );
  const retiroTodas = Boolean(
    resolved &&
    resolved.apiGroup === "retirement" &&
    resolved.navScope === "retiro" &&
    resolved.apiSubgroup === undefined
  );
  const apvTodas = Boolean(
    resolved && resolved.apiGroup === "retirement" && resolved.navScope === "retiro" && resolved.apiSubgroup === "apv"
  );
  const showGroupedToggle = rootInvTodas || retiroTodas || brokerageTodas || apvTodas;
  const brkFetchSub =
    resolved?.apiGroup === "brokerage" && resolved.apiSubgroup != null ? resolved.apiSubgroup : undefined;

  useEffect(() => {
    if (!resolved) return;
    let cancelled = false;
    (async () => {
      try {
        const accP = api.accountsByGroup(resolved.apiGroup, resolved.apiSubgroup);
        const treeBrkP =
          resolved.navScope === "brokerage" && brkFetchSub
            ? api.accountsByGroup("brokerage", undefined)
            : resolved.navScope === "brokerage"
              ? accP
              : Promise.resolve({ accounts: [] as AccountListRow[] });
        const treeInvP =
          resolved.navScope === "root"
            ? api.accountsByGroup("inversiones")
            : Promise.resolve({ accounts: [] as AccountListRow[] });
        const treeRetP =
          resolved.navScope === "retiro"
            ? api.accountsByGroup("retirement")
            : Promise.resolve({ accounts: [] as AccountListRow[] });

        const [acc, tInv, tRet, tBrk, series, perfResult] = await Promise.all([
          accP,
          treeInvP,
          treeRetP,
          treeBrkP,
          api.valuationTimeseries(displayUnit, { group: resolved.apiGroup, subgroup: resolved.apiSubgroup }),
          api.groupMonthlyPerformance(resolved.apiGroup, displayUnit, resolved.apiSubgroup).catch(() => null),
        ]);
        if (!cancelled) {
          setAccounts(acc.accounts);
          setNavInv(tInv.accounts);
          setNavRet(tRet.accounts);
          setNavBrk(tBrk.accounts);
          setTs(series);
          setGroupPerf(perfResult);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolved, displayUnit, brkFetchSub]);

  const displayValuationBlock = useMemo(() => {
    if (!ts?.accounts_in_group) return null;
    if (brokerageTodas && brokerageGroupedAll) {
      return aggregateBrokerageAllViewValuationBlock(ts.accounts_in_group, accounts);
    }
    if (rootInvTodas && invRootGrouped) {
      return aggregateInversionesRootGroupedValuationBlock(ts.accounts_in_group, accounts);
    }
    if (rootInvTodas && !invRootGrouped) {
      return aggregateInversionesRootUngroupedValuationBlock(ts.accounts_in_group, accounts);
    }
    if (retiroTodas && retiroGrouped) {
      return aggregateRetiroGroupedValuationBlock(ts.accounts_in_group, accounts);
    }
    if (apvTodas && apvGrouped) {
      return aggregateApvSubgroupGroupedValuationBlock(ts.accounts_in_group, accounts);
    }
    return ts.accounts_in_group;
  }, [
    ts,
    accounts,
    brokerageTodas,
    brokerageGroupedAll,
    rootInvTodas,
    invRootGrouped,
    retiroTodas,
    retiroGrouped,
    apvTodas,
    apvGrouped,
  ]);

  const displayPieSlices = useMemo(() => {
    if (!ts?.group_allocation_pie) return [];
    const base = ts.group_allocation_pie.map((p) => ({
      name: p.name,
      value: p.value,
      account_id: p.account_id,
    }));
    if (brokerageTodas && brokerageGroupedAll) {
      return aggregateBrokerageAllViewPie(ts.group_allocation_pie, accounts);
    }
    if (rootInvTodas && invRootGrouped) {
      return aggregateInversionesRootGroupedPie(ts.group_allocation_pie, accounts);
    }
    if (rootInvTodas && !invRootGrouped) {
      return aggregateInversionesRootUngroupedPie(ts.group_allocation_pie, accounts);
    }
    if (retiroTodas && retiroGrouped) {
      return aggregateRetiroGroupedPie(ts.group_allocation_pie, accounts);
    }
    if (apvTodas && apvGrouped) {
      return aggregateApvSubgroupGroupedPie(ts.group_allocation_pie, accounts);
    }
    return base;
  }, [
    ts,
    accounts,
    brokerageTodas,
    brokerageGroupedAll,
    rootInvTodas,
    invRootGrouped,
    retiroTodas,
    retiroGrouped,
    apvTodas,
    apvGrouped,
  ]);

  const displayGroupPerf = useMemo(() => {
    if (!groupPerf) return null;
    if (brokerageTodas && brokerageGroupedAll) {
      return aggregateBrokerageAllViewPerformance(groupPerf, accounts);
    }
    if (rootInvTodas && invRootGrouped) {
      return aggregateInversionesRootGroupedPerformance(groupPerf, accounts);
    }
    if (rootInvTodas && !invRootGrouped) {
      return aggregateInversionesRootUngroupedPerformance(groupPerf, accounts);
    }
    if (retiroTodas && retiroGrouped) {
      return aggregateRetiroGroupedPerformance(groupPerf, accounts);
    }
    if (apvTodas && apvGrouped) {
      return aggregateApvSubgroupGroupedPerformance(groupPerf, accounts);
    }
    return groupPerf;
  }, [
    groupPerf,
    accounts,
    brokerageTodas,
    brokerageGroupedAll,
    rootInvTodas,
    invRootGrouped,
    retiroTodas,
    retiroGrouped,
    apvTodas,
    apvGrouped,
  ]);

  const parentBack = useMemo(
    () => (resolved ? inversionesGroupParentBackLink(resolved) : { to: "/", label: "Dashboard" }),
    [resolved]
  );

  const chartColorSlug = useMemo(() => {
    if (!resolved) return "inversiones";
    if (resolved.apiGroup === "brokerage" && resolved.apiSubgroup === "crypto") return "crypto";
    return resolved.apiGroup;
  }, [resolved]);

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
    }));
    const maps = buildGroupTabColorMaps(chartColorSlug, lines);
    return displayGroupPerf.bar_accounts.map((a) => ({
      dataKey: a.bar_data_key,
      name: `Δ ${a.name}`,
      color: maps.byDataKey.get(a.bar_data_key) ?? "#60a5fa",
    }));
  }, [chartColorSlug, displayGroupPerf]);

  if (pathInvalid) {
    return <Navigate to="/inversiones" replace />;
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
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (resolved.apiSubgroup != null && accounts.length === 1) {
    return <Navigate to={`/account/${accounts[0]!.id}`} replace />;
  }

  const pieSlices = displayPieSlices;
  const pieAllocationSlug =
    resolved.apiGroup === "brokerage" && resolved.apiSubgroup === "crypto" ? "crypto" : resolved.apiGroup;
  const retAccounts = navRet.filter((a) => a.group_slug === "retirement");
  const brkAccounts = navBrk.filter((a) => a.group_slug === "brokerage");

  return (
    <main>
      <h1>{resolved.pageTitle}</h1>
      <p className="muted">
        <Link to={parentBack.to}>← {parentBack.label}</Link>
      </p>

      <div className="toggle-row" style={{ flexWrap: "wrap", gap: "0.5rem 1rem" }}>
        <span className="muted">Gráficos: </span>
        <label>
          <input
            type="radio"
            name="adu-inv"
            checked={displayUnit === "clp"}
            onChange={() => setDisplayUnit("clp")}
          />{" "}
          CLP
        </label>
        <label>
          <input type="radio" name="adu-inv" checked={displayUnit === "usd"} onChange={() => setDisplayUnit("usd")} />{" "}
          USD
        </label>
        {showGroupedToggle ? (
          <>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
              <input
                type="checkbox"
                checked={
                  rootInvTodas
                    ? invRootGrouped
                    : apvTodas
                      ? apvGrouped
                      : retiroTodas
                        ? retiroGrouped
                        : brokerageGroupedAll
                }
                onChange={(e) => {
                  const v = e.target.checked;
                  if (rootInvTodas) setInvRootGrouped(v);
                  else if (apvTodas) setApvGrouped(v);
                  else if (retiroTodas) setRetiroGrouped(v);
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
          </>
        ) : null}
      </div>

      {accounts.length === 0 ? (
        <p className="empty muted" style={{ marginTop: "1rem" }}>
          No hay cuentas en esta vista todavía.
        </p>
      ) : (
        <div
          className={`chart-grid${accounts.length > 1 ? "" : " chart-grid--full-line"}`}
          style={{ marginTop: "0.75rem" }}
        >
          <LineChartPanel
            title="Valorización y aportes (todas las cuentas)"
            block={displayValuationBlock!}
            displayUnit={displayUnit}
            includeAccumulatedLines={showGroupedToggle ? showValuationDeposits : true}
            colorPlan={{
              kind: "group-tab",
              groupSlug:
                resolved.apiGroup === "inversiones"
                  ? "inversiones"
                  : resolved.apiGroup === "brokerage"
                    ? "brokerage"
                    : "retirement",
              brokerageSubgroup:
                resolved.apiGroup === "brokerage" &&
                  (resolved.apiSubgroup === "acciones" ||
                    resolved.apiSubgroup === "mutual_funds" ||
                    resolved.apiSubgroup === "crypto")
                  ? resolved.apiSubgroup
                  : undefined,
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
              slices={pieSlices}
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
            {brokerageTodas && brokerageGroupedAll
              ? "Barras por grupo (fondos mutuos, acciones, cripto), área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes. Derivado."
              : rootInvTodas && invRootGrouped
                ? "Barras por Brokerage y Retiro (consolidado), área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes. Derivado."
                : rootInvTodas && !invRootGrouped
                  ? "Barras por fondos mutuos, acciones, cripto, AFP + AFC, APV, área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes. Derivado."
                  : retiroTodas && retiroGrouped
                    ? "Barras por AFP, APV (ambos regímenes) y AFC, área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes. Derivado."
                    : "Barras por cuenta, área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes. Derivado."}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                brokerageTodas && brokerageGroupedAll
                  ? "Δ por grupo, YTD combinado y Δ total"
                  : rootInvTodas && invRootGrouped
                    ? "Δ por Brokerage / Retiro, YTD combinado y Δ total"
                    : rootInvTodas && !invRootGrouped
                      ? "Δ por sub-clase, YTD combinado y Δ total"
                      : retiroTodas && retiroGrouped
                        ? "Δ por AFP / APV / AFC, YTD combinado y Δ total"
                        : "Δ por cuenta, YTD combinado y Δ total"
              }
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
                  color: allocationBucketColor(pieAllocationSlug),
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

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Grupos y cuentas</h2>
        <Table
          wrapStyle={{ marginTop: "0.75rem" }}
          tableClassName="hierarchy-nav-table"
          header={
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Group</th>
                <th>Notes</th>
              </tr>
            </thead>
          }
        >
          {resolved.navScope === "root" ? (
            <>
              <HierarchyNavRow
                depth={0}
                isGroup
                nameCell={
                  <>
                    <Link to="/inversiones">Todas las inversiones</Link>
                    <span className="muted" style={{ marginLeft: 8, fontSize: "0.85rem", fontWeight: 400 }}>
                      (vista consolidada)
                    </span>
                  </>
                }
                categoryCell={<span className="muted">Todas</span>}
                groupCell={<span className="muted">—</span>}
                notesCell={<span className="muted">—</span>}
              />
              <HierarchyNavRow
                depth={1}
                isGroup
                nameCell={<Link to="/inversiones/retiro">Retiro</Link>}
                categoryCell={<span className="muted">—</span>}
                groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                notesCell={<span className="muted">—</span>}
              />
              {(() => {
                const afpAccounts = navInv.filter((a) => a.group_slug === "retirement" && a.category_slug === "afp");
                const afcAccounts = navInv.filter((a) => a.group_slug === "retirement" && a.category_slug === "afc");
                if (afpAccounts.length === 0 && afcAccounts.length === 0) return null;
                const collapseAfp = hideRedundantGroupRow("afp", afpAccounts, retirementAccountNavLabel);
                const collapseAfc = hideRedundantGroupRow("afc", afcAccounts, retirementAccountNavLabel);
                return (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={
                        <Link to="/inversiones/retiro/afp-afc" title={RETIRO_AFP_AFC_GROUP_TITLE}>
                          AFP + AFC
                        </Link>
                      }
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {afpAccounts.length > 0 ? (
                      collapseAfp ? (
                        afpAccounts.map((a) => (
                          <HierarchyNavRow
                            key={a.id}
                            depth={3}
                            isGroup={false}
                            nameCell={
                              <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                            }
                            categoryCell={a.category_label}
                            groupCell={a.group_label}
                            notesCell={a.notes ?? "—"}
                          />
                        ))
                      ) : (
                        <>
                          <HierarchyNavRow
                            depth={3}
                            isGroup
                            nameCell={<Link to="/inversiones/retiro/afp">afp</Link>}
                            categoryCell={<span className="muted">—</span>}
                            groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                            notesCell={<span className="muted">—</span>}
                          />
                          {afpAccounts.map((a) => (
                            <HierarchyNavRow
                              key={a.id}
                              depth={4}
                              isGroup={false}
                              nameCell={
                                <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                              }
                              categoryCell={a.category_label}
                              groupCell={a.group_label}
                              notesCell={a.notes ?? "—"}
                            />
                          ))}
                        </>
                      )
                    ) : null}
                    {afcAccounts.length > 0 ? (
                      collapseAfc ? (
                        afcAccounts.map((a) => (
                          <HierarchyNavRow
                            key={a.id}
                            depth={3}
                            isGroup={false}
                            nameCell={
                              <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                            }
                            categoryCell={a.category_label}
                            groupCell={a.group_label}
                            notesCell={a.notes ?? "—"}
                          />
                        ))
                      ) : (
                        <>
                          <HierarchyNavRow
                            depth={3}
                            isGroup
                            nameCell={<Link to="/inversiones/retiro/afc">afc</Link>}
                            categoryCell={<span className="muted">—</span>}
                            groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                            notesCell={<span className="muted">—</span>}
                          />
                          {afcAccounts.map((a) => (
                            <HierarchyNavRow
                              key={a.id}
                              depth={4}
                              isGroup={false}
                              nameCell={
                                <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                              }
                              categoryCell={a.category_label}
                              groupCell={a.group_label}
                              notesCell={a.notes ?? "—"}
                            />
                          ))}
                        </>
                      )
                    ) : null}
                  </>
                );
              })()}
              <HierarchyNavRow
                depth={2}
                isGroup
                nameCell={<Link to="/inversiones/retiro/apv">apv</Link>}
                categoryCell={<span className="muted">—</span>}
                groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                notesCell={<span className="muted">—</span>}
              />
              {(() => {
                const apvPrincipal = navInv.filter(
                  (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_a_principal"
                );
                if (apvPrincipal.length === 0) return null;
                const collapse = hideRedundantGroupRow(
                  "apv-a — principal",
                  apvPrincipal,
                  retirementAccountNavLabel
                );
                return collapse ? (
                  apvPrincipal.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={3}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={3}
                      isGroup
                      nameCell={
                        <Link to="/inversiones/retiro/apv/apv-a-principal">apv-a — principal</Link>
                      }
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {apvPrincipal.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={4}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              {(() => {
                const apvA = navInv.filter(
                  (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_a"
                );
                const collapse = hideRedundantGroupRow("apv-a", apvA, retirementAccountNavLabel);
                return collapse ? (
                  apvA.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={3}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={3}
                      isGroup
                      nameCell={<Link to="/inversiones/retiro/apv/apv-a">apv-a</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {apvA.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={4}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              {(() => {
                const apvB = navInv.filter(
                  (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_b"
                );
                const collapse = hideRedundantGroupRow("apv-b", apvB, retirementAccountNavLabel);
                return collapse ? (
                  apvB.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={3}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={3}
                      isGroup
                      nameCell={<Link to="/inversiones/retiro/apv/apv-b">apv-b</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {apvB.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={4}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              <HierarchyNavRow
                depth={1}
                isGroup
                nameCell={<Link to="/inversiones/brokerage">brokerage</Link>}
                categoryCell={<span className="muted">—</span>}
                groupCell={<span className="muted">Brokerage</span>}
                notesCell={<span className="muted">—</span>}
              />
              {(() => {
                const inGroup = navInv.filter(
                  (a) => brokeragePortfolioGroupFromCategorySlug(a.category_slug) === "mutual_funds"
                );
                const label = brokeragePortfolioGroupLabel("mutual_funds");
                const path = brokeragePortfolioGroupPath("mutual_funds");
                const collapse = hideRedundantGroupRow(label, inGroup, brokerageAccountNavLabel);
                return collapse ? (
                  inGroup.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={2}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={<Link to={path}>{label}</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">Brokerage</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {inGroup.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={3}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              {(() => {
                const inGroup = navInv.filter(
                  (a) => brokeragePortfolioGroupFromCategorySlug(a.category_slug) === "acciones"
                );
                const label = brokeragePortfolioGroupLabel("acciones");
                const path = brokeragePortfolioGroupPath("acciones");
                const collapse = hideRedundantGroupRow(label, inGroup, brokerageAccountNavLabel);
                return collapse ? (
                  inGroup.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={2}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={<Link to={path}>{label}</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">Brokerage</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {inGroup.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={3}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              {(() => {
                const inGroup = navInv.filter(
                  (a) => brokeragePortfolioGroupFromCategorySlug(a.category_slug) === "cripto"
                );
                const label = brokeragePortfolioGroupLabel("cripto");
                const path = brokeragePortfolioGroupPath("cripto");
                const collapse = hideRedundantGroupRow(label, inGroup, brokerageAccountNavLabel);
                return collapse ? (
                  inGroup.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={2}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={<Link to={path}>{label}</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">Brokerage</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {inGroup.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={3}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
            </>
          ) : null}

          {resolved.navScope === "retiro" ? (
            <>
              <HierarchyNavRow
                depth={0}
                isGroup
                nameCell={
                  <>
                    <Link to="/inversiones/retiro">Todas (retiro)</Link>
                    <span className="muted" style={{ marginLeft: 8, fontSize: "0.85rem", fontWeight: 400 }}>
                      (vista consolidada)
                    </span>
                  </>
                }
                categoryCell={<span className="muted">Todas</span>}
                groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                notesCell={<span className="muted">—</span>}
              />
              {(() => {
                const afpAccounts = retAccounts.filter((a) => a.category_slug === "afp");
                const afcAccounts = retAccounts.filter((a) => a.category_slug === "afc");
                if (afpAccounts.length === 0 && afcAccounts.length === 0) return null;
                const collapseAfp = hideRedundantGroupRow("afp", afpAccounts, retirementAccountNavLabel);
                const collapseAfc = hideRedundantGroupRow("afc", afcAccounts, retirementAccountNavLabel);
                return (
                  <>
                    <HierarchyNavRow
                      depth={1}
                      isGroup
                      nameCell={
                        <Link to="/inversiones/retiro/afp-afc" title={RETIRO_AFP_AFC_GROUP_TITLE}>
                          AFP + AFC
                        </Link>
                      }
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {afpAccounts.length > 0 ? (
                      collapseAfp ? (
                        afpAccounts.map((a) => (
                          <HierarchyNavRow
                            key={a.id}
                            depth={2}
                            isGroup={false}
                            nameCell={
                              <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                            }
                            categoryCell={a.category_label}
                            groupCell={a.group_label}
                            notesCell={a.notes ?? "—"}
                          />
                        ))
                      ) : (
                        <>
                          <HierarchyNavRow
                            depth={2}
                            isGroup
                            nameCell={<Link to="/inversiones/retiro/afp">afp</Link>}
                            categoryCell={<span className="muted">—</span>}
                            groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                            notesCell={<span className="muted">—</span>}
                          />
                          {afpAccounts.map((a) => (
                            <HierarchyNavRow
                              key={a.id}
                              depth={3}
                              isGroup={false}
                              nameCell={
                                <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                              }
                              categoryCell={a.category_label}
                              groupCell={a.group_label}
                              notesCell={a.notes ?? "—"}
                            />
                          ))}
                        </>
                      )
                    ) : null}
                    {afcAccounts.length > 0 ? (
                      collapseAfc ? (
                        afcAccounts.map((a) => (
                          <HierarchyNavRow
                            key={a.id}
                            depth={2}
                            isGroup={false}
                            nameCell={
                              <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                            }
                            categoryCell={a.category_label}
                            groupCell={a.group_label}
                            notesCell={a.notes ?? "—"}
                          />
                        ))
                      ) : (
                        <>
                          <HierarchyNavRow
                            depth={2}
                            isGroup
                            nameCell={<Link to="/inversiones/retiro/afc">afc</Link>}
                            categoryCell={<span className="muted">—</span>}
                            groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                            notesCell={<span className="muted">—</span>}
                          />
                          {afcAccounts.map((a) => (
                            <HierarchyNavRow
                              key={a.id}
                              depth={3}
                              isGroup={false}
                              nameCell={
                                <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                              }
                              categoryCell={a.category_label}
                              groupCell={a.group_label}
                              notesCell={a.notes ?? "—"}
                            />
                          ))}
                        </>
                      )
                    ) : null}
                  </>
                );
              })()}
              <HierarchyNavRow
                depth={1}
                isGroup
                nameCell={<Link to="/inversiones/retiro/apv">apv</Link>}
                categoryCell={<span className="muted">—</span>}
                groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                notesCell={<span className="muted">—</span>}
              />
              {(() => {
                const apvPrincipal = retAccounts.filter(
                  (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_a_principal"
                );
                if (apvPrincipal.length === 0) return null;
                const collapse = hideRedundantGroupRow(
                  "apv-a — principal",
                  apvPrincipal,
                  retirementAccountNavLabel
                );
                return collapse ? (
                  apvPrincipal.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={2}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={
                        <Link to="/inversiones/retiro/apv/apv-a-principal">apv-a — principal</Link>
                      }
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {apvPrincipal.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={3}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              {(() => {
                const apvA = retAccounts.filter(
                  (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_a"
                );
                const collapse = hideRedundantGroupRow("apv-a", apvA, retirementAccountNavLabel);
                return collapse ? (
                  apvA.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={2}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={<Link to="/inversiones/retiro/apv/apv-a">apv-a</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {apvA.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={3}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
              {(() => {
                const apvB = retAccounts.filter(
                  (a) => a.category_slug === "apv" && a.notes === "import:excel|key=apv_b"
                );
                const collapse = hideRedundantGroupRow("apv-b", apvB, retirementAccountNavLabel);
                return collapse ? (
                  apvB.map((a) => (
                    <HierarchyNavRow
                      key={a.id}
                      depth={2}
                      isGroup={false}
                      nameCell={
                        <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                      }
                      categoryCell={a.category_label}
                      groupCell={a.group_label}
                      notesCell={a.notes ?? "—"}
                    />
                  ))
                ) : (
                  <>
                    <HierarchyNavRow
                      depth={2}
                      isGroup
                      nameCell={<Link to="/inversiones/retiro/apv/apv-b">apv-b</Link>}
                      categoryCell={<span className="muted">—</span>}
                      groupCell={<span className="muted">{i18n.t("dashboard.cards.retirement")}</span>}
                      notesCell={<span className="muted">—</span>}
                    />
                    {apvB.map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={3}
                        isGroup={false}
                        nameCell={
                          <Link to={`/account/${a.id}`}>{retirementAccountNavLabel(a)}</Link>
                        }
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                  </>
                );
              })()}
            </>
          ) : null}

          {resolved.navScope === "brokerage" ? (
            <>
              <HierarchyNavRow
                depth={0}
                isGroup
                nameCell={
                  <>
                    <Link to="/inversiones/brokerage">Todas las cuentas</Link>
                    <span className="muted" style={{ marginLeft: 8, fontSize: "0.85rem", fontWeight: 400 }}>
                      (vista consolidada)
                    </span>
                  </>
                }
                categoryCell={<span className="muted">Todas</span>}
                groupCell={<span className="muted">Brokerage</span>}
                notesCell={<span className="muted">—</span>}
              />
              {BROKERAGE_GROUP_ORDER.map((g) => {
                const inGroup = brkAccounts.filter(
                  (a) => brokeragePortfolioGroupFromCategorySlug(a.category_slug) === g
                );
                const label = brokeragePortfolioGroupLabel(g);
                const path = brokeragePortfolioGroupPath(g);
                const collapse = hideRedundantGroupRow(label, inGroup, brokerageAccountNavLabel);
                return (
                  <Fragment key={g}>
                    {collapse ? (
                      inGroup.map((a) => (
                        <HierarchyNavRow
                          key={a.id}
                          depth={1}
                          isGroup={false}
                          nameCell={
                            <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                          }
                          categoryCell={a.category_label}
                          groupCell={a.group_label}
                          notesCell={a.notes ?? "—"}
                        />
                      ))
                    ) : (
                      <>
                        <HierarchyNavRow
                          depth={1}
                          isGroup
                          nameCell={<Link to={path}>{label}</Link>}
                          categoryCell={<span className="muted">—</span>}
                          groupCell={<span className="muted">Brokerage</span>}
                          notesCell={<span className="muted">—</span>}
                        />
                        {inGroup.map((a) => (
                          <HierarchyNavRow
                            key={a.id}
                            depth={2}
                            isGroup={false}
                            nameCell={
                              <Link to={`/account/${a.id}`}>{brokerageAccountNavLabel(a)}</Link>
                            }
                            categoryCell={a.category_label}
                            groupCell={a.group_label}
                            notesCell={a.notes ?? "—"}
                          />
                        ))}
                      </>
                    )}
                  </Fragment>
                );
              })}
              {brkAccounts.some((a) => !brokeragePortfolioGroupFromCategorySlug(a.category_slug)) ? (
                <Fragment key="brk-other">
                  <HierarchyNavRow
                    depth={1}
                    isGroup
                    nameCell={<span className="muted">Otras cuentas</span>}
                    categoryCell={<span className="muted">—</span>}
                    groupCell={<span className="muted">Brokerage</span>}
                    notesCell={<span className="muted">—</span>}
                  />
                  {brkAccounts
                    .filter((a) => !brokeragePortfolioGroupFromCategorySlug(a.category_slug))
                    .map((a) => (
                      <HierarchyNavRow
                        key={a.id}
                        depth={2}
                        isGroup={false}
                        nameCell={<Link to={`/account/${a.id}`}>{a.name}</Link>}
                        categoryCell={a.category_label}
                        groupCell={a.group_label}
                        notesCell={a.notes ?? "—"}
                      />
                    ))}
                </Fragment>
              ) : null}
            </>
          ) : null}
        </Table>
      </section>
    </main>
  );
}
