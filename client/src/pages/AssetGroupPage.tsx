import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AllocationPiePanel, LineChartPanel } from "../components/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { Table } from "../components/Table";
import { api } from "../api";
import { assetGroupPageTitle } from "../i18n";
import { allocationBucketColor, buildGroupTabColorMaps, groupTabPieSliceFill } from "../chartColors";
import type {
  AccountListRow,
  AssetGroupSlug,
  GroupMonthlyPerformanceResponse,
  ValuationTimeseriesResponse,
} from "../types";

interface Props {
  slug: AssetGroupSlug;
}

type DisplayUnit = "clp" | "usd";

export function AssetGroupPage({ slug }: Props) {
  const title = assetGroupPageTitle(slug);
  const [accounts, setAccounts] = useState<AccountListRow[]>([]);
  const [ts, setTs] = useState<ValuationTimeseriesResponse | null>(null);
  const [groupPerf, setGroupPerf] = useState<GroupMonthlyPerformanceResponse | null>(null);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("clp");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [acc, series, perfResult] = await Promise.all([
          api.accountsByGroup(slug),
          api.valuationTimeseries(displayUnit, { group: slug }),
          api.groupMonthlyPerformance(slug, displayUnit).catch(() => null),
        ]);
        if (!cancelled) {
          setAccounts(acc.accounts);
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
  }, [slug, displayUnit]);

  const displayValuationBlock = useMemo(() => ts?.accounts_in_group ?? null, [ts]);

  const groupColorMaps = useMemo(() => {
    const accLines = displayValuationBlock?.accounts;
    if (!accLines?.length) {
      return { byDataKey: new Map<string, string>(), byAccountId: new Map<number, string>() };
    }
    return buildGroupTabColorMaps(slug, accLines);
  }, [slug, displayValuationBlock]);

  const groupPerfBarSeries = useMemo(() => {
    if (!groupPerf?.bar_accounts.length) return [];
    const lines = groupPerf.bar_accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      dataKey: a.bar_data_key,
    }));
    const maps = buildGroupTabColorMaps(slug, lines);
    return groupPerf.bar_accounts.map((a) => ({
      dataKey: a.bar_data_key,
      name: `Δ ${a.name}`,
      color: maps.byDataKey.get(a.bar_data_key) ?? "#60a5fa",
    }));
  }, [slug, groupPerf]);

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

  const pieSlices = ts.group_allocation_pie.map((p) => ({
    name: p.name,
    value: p.value,
    account_id: p.account_id,
  }));

  return (
    <main>
      <h1>{title}</h1>
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>

      <div className="toggle-row" style={{ flexWrap: "wrap", gap: "0.5rem 1rem" }}>
        <span className="muted">Gráficos: </span>
        <label>
          <input
            type="radio"
            name="adu"
            checked={displayUnit === "clp"}
            onChange={() => setDisplayUnit("clp")}
          />{" "}
          CLP
        </label>
        <label>
          <input type="radio" name="adu" checked={displayUnit === "usd"} onChange={() => setDisplayUnit("usd")} />{" "}
          USD
        </label>
      </div>

      {slug === "real_estate" && (
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
      )}

      {accounts.length === 0 ? (
        <p className="empty muted" style={{ marginTop: "1rem" }}>
          No hay cuentas en esta clase todavía.
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
            colorPlan={{
              kind: "group-tab",
              groupSlug: slug,
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
                groupTabPieSliceFill(slug, groupColorMaps, slice.account_id, {
                  allocationBucketSlug: slug,
                })
              }
            />
          )}
        </div>
      )}

      {accounts.length > 0 &&
      groupPerf &&
      groupPerf.points.length > 0 &&
      groupPerfBarSeries.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem", fontSize: "1.15rem" }}>P/L mensual — YTD (grupo)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            Barras por cuenta, área YTD (suma de Δ del mes en el año calendario), rombo = Δ total del mes. Derivado.
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title="Δ por cuenta, YTD combinado y Δ total"
              points={groupPerf.points}
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
              points={groupPerf.points}
              displayUnit={displayUnit}
              barSeries={[
                {
                  dataKey: "delta_total",
                  name: "Monthly Δ (consolidated)",
                  color: allocationBucketColor(slug),
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

      <h2 style={{ marginTop: "2rem" }}>Accounts in this class</h2>
      <Table
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
        {accounts.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              No accounts in this class yet. Create one with{" "}
              <span className="mono">POST /api/accounts</span> using a{" "}
              <span className="mono">category_id</span> from the asset tree.
            </td>
          </tr>
        ) : (
          accounts.map((a) => (
            <tr key={a.id}>
              <td>
                <Link to={`/account/${a.id}`}>{a.name}</Link>
              </td>
              <td>{a.category_label}</td>
              <td className="muted">{a.group_label}</td>
              <td className="muted">{a.notes ?? "—"}</td>
            </tr>
          ))
        )}
      </Table>
    </main>
  );
}
