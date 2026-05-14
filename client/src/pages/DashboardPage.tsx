import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ValuationLineCharts } from "../components/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { api } from "../api";
import { allocationBucketColor } from "../chartColors";
import {
  rollupRetirementBrokeragePerfYearly,
  rollupTimeseriesBlockYearEnd,
  type DashboardChartGranularity,
} from "../dashboardTimeseriesYearly";
import { formatClp, formatUsd, clpToUsd, formatInstrumentUnits, formatMoneyForPie } from "../format";
import type {
  DashboardResponse,
  FxLatest,
  GroupMonthlyPerformanceResponse,
  ValuationTimeseriesResponse,
} from "../types";

type DisplayUnit = "clp" | "usd";

export function DashboardPage() {
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [ts, setTs] = useState<ValuationTimeseriesResponse | null>(null);
  const [fx, setFx] = useState<FxLatest | null>(null);
  const [retirementPerf, setRetirementPerf] = useState<GroupMonthlyPerformanceResponse | null>(null);
  const [brokeragePerf, setBrokeragePerf] = useState<GroupMonthlyPerformanceResponse | null>(null);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("clp");
  const [chartGranularity, setChartGranularity] = useState<DashboardChartGranularity>("monthly");
  const [err, setErr] = useState<string | null>(null);

  const showUsd = displayUnit === "usd";
  const isYearly = chartGranularity === "yearly";
  const xAxisGranularity = isYearly ? "year" : "month";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, f, t, retP, brkP] = await Promise.all([
          api.dashboard(showUsd),
          api.fxLatest(),
          api.valuationTimeseries(displayUnit),
          api.groupMonthlyPerformance("retirement", displayUnit).catch(() => null),
          api.groupMonthlyPerformance("brokerage", displayUnit).catch(() => null),
        ]);
        if (!cancelled) {
          setDash(d);
          setFx(f);
          setTs(t);
          setRetirementPerf(retP);
          setBrokeragePerf(brkP);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayUnit, showUsd]);

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

  const tsForCharts = useMemo((): ValuationTimeseriesResponse | null => {
    if (!ts?.accounts_ex_property || !ts.overview) return ts;
    if (!isYearly) return ts;
    const overviewRolled = rollupTimeseriesBlockYearEnd({
      points: ts.overview.points,
      lines: ts.overview.lines,
    });
    return {
      ...ts,
      accounts_ex_property: rollupTimeseriesBlockYearEnd(ts.accounts_ex_property),
      overview: { lines: ts.overview.lines, points: overviewRolled.points },
    };
  }, [ts, isYearly]);

  const dataKeyToGroup = useMemo(() => {
    if (!dash) return {};
    const m: Record<string, string> = {};
    for (const a of dash.accounts) {
      m[String(a.account_id)] = a.group_slug;
    }
    m.stocks_total = "brokerage";
    m.stocks_total__dep = "brokerage";
    m.crypto_total = "crypto";
    m.crypto_total__dep = "crypto";
    return m;
  }, [dash]);

  if (err) {
    return (
      <main className="page">
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!dash || !tsForCharts || !tsForCharts.accounts_ex_property || !tsForCharts.overview) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const rateUsd = fx?.clp_per_usd;
  const fmtClp = (clp: number) => formatClp(clp);
  const fmtUsdPos = (usd: number | null | undefined) =>
    usd != null ? formatUsd(usd) : "—";
  const fmtFlow = (clp: number) =>
    showUsd && rateUsd ? formatUsd(clpToUsd(clp, rateUsd)) : formatClp(clp);

  /** Bucket / net-worth cards: USD from dashboard API (FX per account as-of). */
  const fmtVal = (clp: number, apiUsd?: number | null) => {
    if (showUsd && apiUsd != null && Number.isFinite(apiUsd)) return formatUsd(apiUsd);
    return fmtClp(clp);
  };

  const useUsdPie =
    showUsd &&
    dash.allocation.some((a) => a.value_usd != null && Number.isFinite(a.value_usd) && a.value_usd > 0);

  const pieData = dash.allocation
    .filter((a) => a.group_slug !== "liabilities")
    .map((a) => ({
      name: a.group_label,
      value: useUsdPie && a.value_usd != null ? a.value_usd : a.value_clp,
      group_slug: a.group_slug,
    }));

  return (
    <main className="page">
      <h1>Dashboard</h1>
      <div className="toggle-row">
        <span className="muted">Valores: </span>
        <label>
          <input
            type="radio"
            name="du"
            checked={displayUnit === "clp"}
            onChange={() => setDisplayUnit("clp")}
          />{" "}
          CLP
        </label>
        <label>
          <input
            type="radio"
            name="du"
            checked={displayUnit === "usd"}
            onChange={() => setDisplayUnit("usd")}
            disabled={!rateUsd}
          />{" "}
          USD
          {rateUsd ? ` (FX ${fx?.date})` : ""}
        </label>
        {!rateUsd && (
          <span className="muted"> — USD requiere tipo de cambio en la API.</span>
        )}
        <span className="muted" style={{ marginLeft: "1.25rem" }}>
          Gráficos:{" "}
        </span>
        <label>
          <input
            type="radio"
            name="cg"
            checked={chartGranularity === "monthly"}
            onChange={() => setChartGranularity("monthly")}
          />{" "}
          Mensual
        </label>
        <label>
          <input
            type="radio"
            name="cg"
            checked={chartGranularity === "yearly"}
            onChange={() => setChartGranularity("yearly")}
          />{" "}
          Anual
        </label>
      </div>
      {isYearly ? (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.35rem", maxWidth: "58rem" }}>
          Vista anual: las valorizaciones usan el <strong>último mes</strong> de cada año calendario. El P/L retiro +
          broker suma los <strong>Δ mensuales</strong> de ese año en un solo punto.
        </p>
      ) : null}

      <div className="cards">
        <div className="card">
          <div className="label">Net worth</div>
          <div className="value mono">{fmtVal(dash.totals.net_worth_clp, dash.totals.net_worth_usd)}</div>
          <div className="muted" style={{ fontSize: "0.7rem", marginTop: "0.25rem" }}>
            Activos (sin pasivos)
          </div>
        </div>
        <div className="card">
          <div className="label">Total deposits (tracked)</div>
          <div className="value mono">{fmtFlow(dash.totals.deposits_clp)}</div>
          {showUsd && (
            <div className="muted" style={{ fontSize: "0.7rem", marginTop: "0.25rem" }}>
              aprox. (último tipo)
            </div>
          )}
        </div>
        <div className="card">
          <div className="label">Real estate</div>
          <div className="value mono">{fmtVal(dash.totals.real_estate_clp, dash.totals.real_estate_usd)}</div>
        </div>
        <div className="card">
          <div className="label">Retirement</div>
          <div className="value mono">{fmtVal(dash.totals.retirement_clp, dash.totals.retirement_usd)}</div>
        </div>
        <div className="card">
          <div className="label">Brokerage</div>
          <div className="value mono">{fmtVal(dash.totals.brokerage_clp, dash.totals.brokerage_usd)}</div>
        </div>
        <div className="card">
          <div className="label">Cash & equivalents</div>
          <div className="value mono">{fmtVal(dash.totals.cash_eqs_clp, dash.totals.cash_eqs_usd)}</div>
        </div>
        <div className="card">
          <div className="label">Crypto</div>
          <div className="value mono">{fmtVal(dash.totals.crypto_clp, dash.totals.crypto_usd)}</div>
        </div>
        <div className="card">
          <div className="label">Liabilities</div>
          <div className="value mono">{fmtVal(dash.totals.liabilities_clp, dash.totals.liabilities_usd)}</div>
        </div>
      </div>

      <ValuationLineCharts
        displayUnit={displayUnit}
        primaryTitle="Cuentas principales (sin inmuebles)"
        primary={tsForCharts.accounts_ex_property}
        secondaryTitle="Inmuebles, buckets consolidados y patrimonio neto"
        secondary={{ lines: tsForCharts.overview.lines, points: tsForCharts.overview.points }}
        thickLineDataKey="total_nw"
        includeAccumulatedLines={false}
        primaryColorPlan={{ kind: "dashboard-primary", dataKeyToGroup }}
        secondaryColorPlan={{ kind: "dashboard-overview" }}
        xAxisGranularity={xAxisGranularity}
      />

      {retirementBrokerageForCharts.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>
            Retirement &amp; brokerage — {isYearly ? "annual P/L (calendar year)" : "monthly P/L (YTD)"}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {isYearly ? (
              <>
                Barras: suma de los Δ mensuales nominales de cada clase en el año. Área: total combinado del año.
                Línea: suma combinada anual.
              </>
            ) : (
              <>
                Bars: each class’s monthly nominal Δ (same basis as the class tabs). Area: calendar{" "}
                <strong>YTD</strong> of <strong>retirement + brokerage</strong> combined. Line: combined monthly Δ.
              </>
            )}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                isYearly
                  ? "Annual Δ by class, combined year total and combined annual Δ"
                  : "Monthly Δ by class, combined YTD and combined monthly Δ"
              }
              titleAs="h3"
              points={retirementBrokerageForCharts}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_retirement",
                  name: isYearly ? "Annual Δ retirement" : "Monthly Δ retirement",
                  color: allocationBucketColor("retirement"),
                },
                {
                  dataKey: "delta_brokerage",
                  name: isYearly ? "Annual Δ brokerage" : "Monthly Δ brokerage",
                  color: allocationBucketColor("brokerage"),
                },
              ]}
              areaKey="ytd_combined"
              areaName={isYearly ? "Year total (combined)" : "YTD (retirement + brokerage)"}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              lineKey="delta_combined"
              lineName={isYearly ? "Σ annual Δ" : "Σ monthly Δ"}
            />
          </div>
          <h2 style={{ marginTop: "1.75rem" }}>
            Retirement &amp; brokerage — {isYearly ? "accumulated (annual steps)" : "accumulated earnings"}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {isYearly ? (
              <>
                Una barra = suma anual combinada; área = <strong>Accumulated earnings</strong> (suma acumulada de esas
                anualidades desde el primer año).
              </>
            ) : (
              <>
                One bar = combined monthly Δ; area = <strong>Accumulated earnings</strong> from the first month
                (continuous, no year stripes).
              </>
            )}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                isYearly
                  ? "Annual Δ (combined) and accumulated earnings"
                  : "Monthly Δ (combined) and accumulated earnings"
              }
              titleAs="h3"
              points={retirementBrokerageForCharts}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_combined",
                  name: isYearly ? "Annual Δ (retirement + brokerage)" : "Monthly Δ (retirement + brokerage)",
                  color: "#38bdf8",
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

      <h2>Allocation (latest valuations)</h2>
      {pieData.length === 0 ? (
        <p className="empty">Add accounts and valuations to see the chart.</p>
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
                  <Cell key={i} fill={allocationBucketColor(row.group_slug)} />
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

      <h2>Accounts</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Class</th>
              <th>Category</th>
              <th>Ticker</th>
              <th>Cuotas</th>
              <th>Net inflow</th>
              <th>Current value</th>
              <th>CLP / unit</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {dash.accounts.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  No accounts yet. Open an asset tab and note category IDs for{" "}
                  <span className="mono">POST /api/accounts</span>.
                </td>
              </tr>
            ) : (
              dash.accounts.map((a) => (
                <tr key={a.account_id}>
                  <td>
                    <Link to={`/account/${a.account_id}`}>{a.name}</Link>
                  </td>
                  <td>{a.group_label}</td>
                  <td>{a.category_label}</td>
                  <td className="mono">{a.position?.ticker ?? "—"}</td>
                  <td className="mono">
                    {a.position?.units != null && Number.isFinite(a.position.units)
                      ? formatInstrumentUnits(a.position.units, a.position.units_kind)
                      : "—"}
                  </td>
                  <td className="mono">{fmtFlow(a.deposits_clp)}</td>
                  <td className="mono">
                    {showUsd
                      ? fmtUsdPos(a.current_value_usd ?? null)
                      : a.current_value_clp != null
                        ? fmtClp(a.current_value_clp)
                        : "—"}
                  </td>
                  <td className="mono">
                    {a.position?.value_per_unit_clp != null
                      ? fmtClp(a.position.value_per_unit_clp)
                      : "—"}
                  </td>
                  <td className="muted">{a.valuation_as_of ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
