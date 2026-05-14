import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { LineChartPanel } from "../components/ValuationLineCharts";
import { api } from "../api";
import { DEFAULT_LINE_COLORS } from "../chartColors";
import type {
  AccountDepositInflowsResponse,
  AccountMonthlyPerformanceResponse,
  AccountMortgageLedgerResponse,
  AccountPositionSnapshot,
  AccountValuationTimeseriesResponse,
  DeptoMortgageSheetRow,
} from "../types";
import {
  formatClp,
  formatUsdFine,
  formatInstrumentUnits,
  formatUfUnits,
  formatUfUnitsFine,
} from "../format";

function cellClp(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return formatClp(n);
}

function cellTxt(s: string | null | undefined) {
  if (s == null || !String(s).trim()) return "—";
  return s;
}

function cellPct(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  const s = (p * 100).toFixed(2).replace(".", ",");
  return `${s}%`;
}

function tasaPlusLabel(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n}%`;
}

function MortgageDividendosTable({ ledger }: { ledger: AccountMortgageLedgerResponse }) {
  const m = ledger.meta;
  return (
    <>
      <h2 style={{ marginTop: "1.5rem" }}>Hipoteca / dividendos (hoja depto)</h2>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.65rem", maxWidth: "58rem" }}>
        Tabla leída directamente de <span className="mono">{m?.csv_path ?? "cfraser/depto-dividendos.csv"}</span>: cada
        fila con monto CLP es un pago (puede haber varios en un mes). La tasa anual del crédito en el modelo es{" "}
        <strong>4,95%</strong>; la columna <strong>+ tasa</strong> del CSV incluye inflación y el spread de la hoja.
      </p>
      {m && (
        <div className="cards" style={{ marginBottom: "0.75rem" }}>
          <div className="card">
            <div className="label">Vivienda (hoja)</div>
            <div className="value mono">
              {m.valor_vivienda_uf != null ? formatUfUnits(m.valor_vivienda_uf) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">Hipoteca tras pie</div>
            <div className="value mono">
              {m.hipoteca_tras_pie_uf != null ? formatUfUnits(m.hipoteca_tras_pie_uf) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">Pie (CLP / UF)</div>
            <div className="value mono" style={{ fontSize: "0.95rem" }}>
              {m.pie_clp != null ? formatClp(m.pie_clp) : "—"} · {formatUfUnitsFine(m.pie_uf)}
            </div>
          </div>
          <div className="card">
            <div className="label">Filas de pago</div>
            <div className="value mono">{m.row_count}</div>
          </div>
        </div>
      )}
      <div className="table-wrap" style={{ overflowX: "auto" }}>
        <table className="mortgage-sheet" style={{ fontSize: "0.78rem" }}>
          <thead>
            <tr>
              <th rowSpan={2}>Cuota</th>
              <th rowSpan={2}>Fecha</th>
              <th rowSpan={2}>Pago CLP</th>
              <th rowSpan={2}>Pago UF</th>
              <th rowSpan={2}>% div.</th>
              <th rowSpan={2}>UF día</th>
              <th rowSpan={2}>m/m</th>
              <th rowSpan={2}>y/y</th>
              <th rowSpan={2}>+ tasa</th>
              <th rowSpan={2}>Crédito UF</th>
              <th rowSpan={2}>% créd.</th>
              <th rowSpan={2}>Restante CLP</th>
              <th rowSpan={2}>Δ crédito</th>
              <th rowSpan={2}>Valor neto UF</th>
              <th rowSpan={2}>Valor neto CLP</th>
              <th rowSpan={2}>Pagado neto UF</th>
              <th rowSpan={2}>Δ VN CLP</th>
              <th rowSpan={2}>Vivienda UF</th>
              <th rowSpan={2}>Vivienda CLP</th>
              <th rowSpan={2}>Min UF</th>
              <th colSpan={2}>Incendio</th>
              <th colSpan={2}>Desgravamen</th>
              <th colSpan={2}>Total seguros</th>
              <th colSpan={2}>Amortización</th>
              <th colSpan={2}>Amort. ext</th>
              <th colSpan={2}>Interés</th>
              <th rowSpan={2}>Δ créd. (amort)</th>
              <th rowSpan={2}>Int. oculto</th>
              <th rowSpan={2}>Int. oculto B</th>
              <th rowSpan={2}>Int. real</th>
              <th rowSpan={2}>Int. calc UF</th>
              <th rowSpan={2}>amort/int</th>
              <th rowSpan={2}>Pago acum.</th>
              <th rowSpan={2}>Amort acum</th>
              <th rowSpan={2}>Int acum</th>
            </tr>
            <tr>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
            </tr>
          </thead>
          <tbody>
            {ledger.rows.map((row, idx) => (
              <tr key={`${row.cuota}-${row.occurred_on}-${idx}`}>
                <td className="mono">{row.cuota}</td>
                <td>{row.occurred_on}</td>
                <td className="mono">{cellClp(row.pago_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.pago_uf)}</td>
                <td className="mono muted">{cellTxt(row.pct_dividendo)}</td>
                <td className="mono">{row.uf_clp_day != null ? formatClp(Math.round(row.uf_clp_day)) : "—"}</td>
                <td className="mono muted">{cellTxt(row.mm_pct)}</td>
                <td className="mono muted">{cellTxt(row.yy_pct)}</td>
                <td className="mono muted">{tasaPlusLabel(row.tasa_plus)}</td>
                <td className="mono">{row.credito_restante_uf != null ? formatUfUnits(row.credito_restante_uf) : "—"}</td>
                <td className="mono muted">{cellTxt(row.pct_credito_uf)}</td>
                <td className="mono">{cellClp(row.restante_clp)}</td>
                <td className="mono">{cellClp(row.delta_credito_clp)}</td>
                <td className="mono">{row.valor_neto_uf != null ? formatUfUnits(row.valor_neto_uf) : "—"}</td>
                <td className="mono">{cellClp(row.valor_neto_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.pagado_neto_uf)}</td>
                <td className="mono">{cellClp(row.delta_valor_neto_clp)}</td>
                <td className="mono">{row.valor_vivienda_uf != null ? formatUfUnits(row.valor_vivienda_uf) : "—"}</td>
                <td className="mono">{cellClp(row.valor_vivienda_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.min_uf)}</td>
                <td className="mono">{cellClp(row.incendio_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.incendio_uf)}</td>
                <td className="mono">{cellClp(row.desgravamen_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.desgravamen_uf)}</td>
                <td className="mono">{cellClp(row.total_seguros_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.total_seguros_uf)}</td>
                <td className="mono">{cellClp(row.amortizacion_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.amortizacion_uf)}</td>
                <td className="mono">{cellClp(row.amortizacion_ext_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.amortizacion_ext_uf)}</td>
                <td className="mono">{cellClp(row.interes_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.interes_uf)}</td>
                <td className="mono">{cellClp(row.delta_credito_amort_clp)}</td>
                <td className="mono">{cellClp(row.interes_oculto_clp)}</td>
                <td className="mono">{cellClp(row.interes_oculto_b_clp)}</td>
                <td className="mono">{cellClp(row.interes_real_clp)}</td>
                <td className="mono">{formatUfUnitsFine(row.interes_calculado_uf)}</td>
                <td className="mono muted">{cellTxt(row.amort_interes_text)}</td>
                <td className="mono muted">{cellClp(row.pago_acumulado_clp)}</td>
                <td className="mono muted">{cellClp(row.amort_acum_clp)}</td>
                <td className="mono muted">{cellClp(row.interes_acum_clp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface Summary {
  account_id: number;
  category_slug: string | null;
  deposits_clp: number;
  withdrawals_clp: number;
  latest_valuation_clp: number | null;
  latest_valuation_date: string | null;
  position: AccountPositionSnapshot | null;
}

interface Movement {
  id: number;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
}

interface BrokerageFlow {
  id: number;
  occurred_on: string;
  flow_kind: string;
  amount_clp: number | null;
  amount_usd: number | null;
  ticker: string | null;
  note: string | null;
}

type DisplayUnit = "clp" | "usd";
type ChartGranularity = "monthly" | "daily";

/** Default visible rows in “Detalle por mes” (newest first); rest behind “Mostrar más”. */
const MONTHLY_PERF_COLLAPSED = 12;

export function AccountDetailPage() {
  const { id } = useParams();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [flows, setFlows] = useState<BrokerageFlow[]>([]);
  const [ts, setTs] = useState<AccountValuationTimeseriesResponse | null>(null);
  const [depositInflows, setDepositInflows] = useState<AccountDepositInflowsResponse | null>(null);
  const [mortgageLedger, setMortgageLedger] = useState<AccountMortgageLedgerResponse | null>(null);
  const [monthlyPerf, setMonthlyPerf] = useState<AccountMonthlyPerformanceResponse | null>(null);
  const [monthlyPerfErr, setMonthlyPerfErr] = useState<string | null>(null);
  const [monthlyPerfExpanded, setMonthlyPerfExpanded] = useState(false);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("clp");
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>("monthly");
  const [err, setErr] = useState<string | null>(null);

  const ytdChartPoints = useMemo(() => {
    if (!monthlyPerf?.monthly.length) return [];
    return [...monthlyPerf.monthly].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      nominal_pl: r.nominal_pl ?? 0,
      ytd_nominal_pl: r.ytd_nominal_pl ?? 0,
    }));
  }, [monthlyPerf]);

  const accChartPoints = useMemo(() => {
    if (!monthlyPerf?.monthly.length) return [];
    return [...monthlyPerf.monthly].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      delta_month: r.nominal_pl ?? 0,
      accumulated_earnings: r.cumulative_nominal_pl ?? 0,
    }));
  }, [monthlyPerf]);

  useEffect(() => {
    setMonthlyPerfExpanded(false);
  }, [id, displayUnit]);

  const visibleMonthlyPerfRows = useMemo(() => {
    if (!monthlyPerf?.monthly.length) return [];
    const rows = monthlyPerf.monthly;
    if (monthlyPerfExpanded || rows.length <= MONTHLY_PERF_COLLAPSED) return rows;
    return rows.slice(0, MONTHLY_PERF_COLLAPSED);
  }, [monthlyPerf, monthlyPerfExpanded]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [s, m, f, series, dep, ml] = await Promise.all([
          api.accountSummary(id),
          api.accountMovements(id),
          api.brokerageFlows(id).catch(() => ({ flows: [] as BrokerageFlow[] })),
          api.accountValuationTimeseries(id, displayUnit, { granularity: chartGranularity }),
          api.accountDepositInflows(id),
          api.accountMortgageLedger(id).catch(() => ({
            account_id: Number(id),
            source: "none" as const,
            meta: null,
            rows: [] as DeptoMortgageSheetRow[],
          })),
        ]);
        if (!cancelled) {
          setSummary(s);
          setMovements(m.movements ?? []);
          setFlows(f.flows ?? []);
          setTs(series);
          setDepositInflows(dep);
          setMortgageLedger(ml);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, displayUnit, chartGranularity]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setMonthlyPerfErr(null);
    (async () => {
      try {
        const p = await api.accountMonthlyPerformance(id, displayUnit);
        if (!cancelled) setMonthlyPerf(p);
      } catch (e) {
        if (!cancelled) {
          setMonthlyPerf(null);
          setMonthlyPerfErr(e instanceof Error ? e.message : "No se pudo cargar el rendimiento mensual.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, displayUnit]);

  if (err) {
    return (
      <main className="page">
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!summary || !ts || !depositInflows || !mortgageLedger) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const showMonthlyPerformance = summary.category_slug !== "cuenta_corriente";
  const fmtPerf = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return "—";
    return displayUnit === "usd" ? formatUsdFine(n) : formatClp(n);
  };

  return (
    <main className="page">
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>
      <h1>{ts.name}</h1>
      <p className="muted mono">Account #{summary.account_id}</p>

      {summary.position != null && (
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <h2 style={{ marginBottom: "0.35rem" }}>Posición (ticker y cuotas)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
            Acciones: cuotas desde <span className="mono">cfraser/net worth-stocks.csv</span> (columna valor
            acción). Cripto: saldo neto de moneda desde notas de movimientos del import.
          </p>
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Cuotas / unidades</th>
                <th>Depositado (CLP)</th>
                <th>Valor hoy (CLP)</th>
                <th>Fecha valor</th>
                <th>Valor / unidad (CLP)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">{summary.position.ticker}</td>
                <td className="mono">
                  {summary.position.units != null && Number.isFinite(summary.position.units)
                    ? formatInstrumentUnits(summary.position.units, summary.position.units_kind)
                    : "—"}
                </td>
                <td className="mono">{formatClp(summary.position.deposited_clp)}</td>
                <td className="mono">
                  {summary.position.value_clp != null ? formatClp(summary.position.value_clp) : "—"}
                </td>
                <td className="muted">{summary.position.value_as_of ?? "—"}</td>
                <td className="mono">
                  {summary.position.value_per_unit_clp != null
                    ? formatClp(summary.position.value_per_unit_clp)
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="toggle-row">
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
        <span className="muted" style={{ marginLeft: "1rem" }}>
          Serie:{" "}
        </span>
        <label>
          <input
            type="radio"
            name="gran"
            checked={chartGranularity === "monthly"}
            onChange={() => setChartGranularity("monthly")}
          />{" "}
          Mensual (fin de mes)
        </label>
        <label>
          <input
            type="radio"
            name="gran"
            checked={chartGranularity === "daily"}
            onChange={() => setChartGranularity("daily")}
          />{" "}
          Diario
        </label>
      </div>
      {chartGranularity === "daily" && ts.granularity === "monthly" ? (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
          Serie diaria no disponible para esta cuenta (solo SPY/VEA con unidades en bolsa e import Yahoo).
        </p>
      ) : null}

      <div className="chart-grid chart-grid--full-line" style={{ marginTop: "0.75rem" }}>
        <LineChartPanel title="Valorización y aportes" block={ts.accounts} displayUnit={displayUnit} />
      </div>

      {showMonthlyPerformance ? (
        <>
          <h2 style={{ marginTop: "1.25rem" }}>Rendimiento mensual (calculado)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            Dos gráficos: (1) P/L mensual vs <strong>YTD</strong> (área reinicia cada enero). (2) mismo Δ mensual con
            área <strong>Accumulated earnings</strong> (continua desde el primer mes, sin franjas por año). La tabla
            conserva el detalle. Misma base que valorización y aportes. Unidad:{" "}
            <strong>{displayUnit === "usd" ? "USD" : "CLP"}</strong>
            {chartGranularity === "daily" ? (
              <> La serie mensual no sigue la vista diaria (aportes solo en mensual).</>
            ) : null}
          </p>
          {monthlyPerfErr ? (
            <p className="error" style={{ fontSize: "0.9rem" }}>
              {monthlyPerfErr}
            </p>
          ) : monthlyPerf == null ? (
            <p className="muted">Cargando rendimiento…</p>
          ) : monthlyPerf.monthly.length === 0 ? (
            <p className="muted">
              Sin suficientes meses de valorización mensual para calcular variaciones (o la cuenta solo tiene un
              punto).
            </p>
          ) : (
            <>
              <h3 style={{ marginTop: "0.35rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
                YTD (año calendario)
              </h3>
              <div className="chart-grid chart-grid--full-line" style={{ marginTop: 0 }}>
                <MonthlyPerformanceComboChart
                  title="P/L mensual vs YTD"
                  titleAs="h3"
                  points={ytdChartPoints}
                  displayUnit={displayUnit}
                  barSeries={[
                    {
                      dataKey: "nominal_pl",
                      name: "Δ mes (P/L nominal)",
                      color: DEFAULT_LINE_COLORS[0] ?? "#3b82f6",
                    },
                  ]}
                  areaKey="ytd_nominal_pl"
                  areaName="YTD"
                  areaFill="rgba(148, 163, 184, 0.28)"
                  areaStroke="#94a3b8"
                />
              </div>
              <h3 style={{ marginTop: "1.35rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
                Accumulated earnings
              </h3>
              <div className="chart-grid chart-grid--full-line" style={{ marginTop: 0 }}>
                <MonthlyPerformanceComboChart
                  title="Monthly Δ y accumulated earnings"
                  titleAs="h3"
                  points={accChartPoints}
                  displayUnit={displayUnit}
                  barSeries={[
                    {
                      dataKey: "delta_month",
                      name: "Monthly Δ",
                      color: DEFAULT_LINE_COLORS[2] ?? "#a78bfa",
                    },
                  ]}
                  areaKey="accumulated_earnings"
                  areaName="Accumulated earnings"
                  areaFill="rgba(148, 163, 184, 0.28)"
                  areaStroke="#94a3b8"
                  alternateYearAreaStripes={false}
                />
              </div>
              <h3 style={{ marginTop: "1.25rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
                Detalle por mes
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Mes (cierre)</th>
                      <th>Cierre</th>
                      <th>Cierre ant.</th>
                      <th>Aportes netos</th>
                      <th>Stock inflows</th>
                      <th>P/L mes</th>
                      <th>% mes</th>
                      <th>P/L YTD</th>
                      <th>P/L acum.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMonthlyPerfRows.map((row) => (
                      <tr key={row.as_of_date}>
                        <td className="mono">{row.as_of_date}</td>
                        <td className="mono">{fmtPerf(row.closing_value)}</td>
                        <td className="mono">{fmtPerf(row.prior_closing)}</td>
                        <td className="mono">{fmtPerf(row.net_capital_flow)}</td>
                        <td className="mono">
                          {(() => {
                            const slug = summary?.category_slug ?? "";
                            const kind =
                              slug === "btc" || slug === "eth" ? ("coin" as const) : ("shares" as const);
                            const u = row.stock_units_inflow ?? 0;
                            if (!Number.isFinite(u) || u === 0) return "—";
                            return formatInstrumentUnits(u, kind);
                          })()}
                        </td>
                        <td className="mono">{fmtPerf(row.nominal_pl)}</td>
                        <td className="mono">{cellPct(row.pct_month)}</td>
                        <td className="mono">{fmtPerf(row.ytd_nominal_pl)}</td>
                        <td className="mono">{fmtPerf(row.cumulative_nominal_pl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {monthlyPerf.monthly.length > MONTHLY_PERF_COLLAPSED ? (
                  <div style={{ marginTop: "0.65rem" }}>
                    {!monthlyPerfExpanded ? (
                      <button
                        type="button"
                        onClick={() => setMonthlyPerfExpanded(true)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--accent)",
                          cursor: "pointer",
                          padding: 0,
                          font: "inherit",
                          textDecoration: "underline",
                        }}
                      >
                        Mostrar más ({monthlyPerf.monthly.length - MONTHLY_PERF_COLLAPSED} meses anteriores)
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMonthlyPerfExpanded(false)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--accent)",
                          cursor: "pointer",
                          padding: 0,
                          font: "inherit",
                          textDecoration: "underline",
                        }}
                      >
                        Ocultar meses anteriores
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </>
      ) : null}

      {mortgageLedger.source === "csv" && mortgageLedger.rows.length > 0 ? (
        <MortgageDividendosTable ledger={mortgageLedger} />
      ) : mortgageLedger.source === "csv" ? (
        <p className="muted" style={{ marginTop: "1rem" }}>
          Categoría inmuebles: no hay filas con pago CLP en <span className="mono">cfraser/depto-dividendos.csv</span>
          {mortgageLedger.meta?.csv_absolute_path ? (
            <>
              . El servidor leyó{" "}
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {mortgageLedger.meta.csv_absolute_path}
              </span>
              {mortgageLedger.meta.csv_file_exists === false ? " (archivo no encontrado)" : ""}.
            </>
          ) : null}{" "}
          Re-exporta la hoja dividendos desde Numbers o revisa <span className="mono">CFRASER_CSV_DIR</span> si apunta
          a otra carpeta.
        </p>
      ) : null}

      <div className="cards" style={{ marginTop: "1.5rem" }}>
        <div className="card">
          <div className="label">Flujo neto (mov + bolsa)</div>
          <div className="value mono">{formatClp(summary.deposits_clp)}</div>
        </div>
        <div className="card">
          <div className="label">Withdrawals</div>
          <div className="value mono">{formatClp(summary.withdrawals_clp)}</div>
        </div>
        <div className="card">
          <div className="label">Latest valuation</div>
          <div className="value mono">
            {summary.latest_valuation_clp != null ? formatClp(summary.latest_valuation_clp) : "—"}
          </div>
          <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
            {summary.latest_valuation_date ?? ""}
          </div>
        </div>
      </div>

      <h2>Historial de aportes (fuente única)</h2>
      <p className="muted" style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}>
        Solo capital externo: movimientos en CLP más bolsa <strong>deposit_clp</strong> y menos{" "}
        <strong>withdrawal_clp</strong>. Las compras USD, dividendos y reinversiones no cuentan aquí (no son plata nueva
        que ingreses); siguen en la tabla Bolsa y en la columna Stock inflows cuando hay unidades. Misma base que la línea
        “aportes acum.” y el total de
        arriba.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Monto CLP</th>
              <th>Acumulado CLP</th>
            </tr>
          </thead>
          <tbody>
            {depositInflows.events.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  Sin flujos de capital registrados.
                </td>
              </tr>
            ) : (
              depositInflows.events.map((e, idx) => (
                <tr key={`${e.occurred_on}-${idx}`}>
                  <td>{e.occurred_on}</td>
                  <td className="mono">{formatClp(e.amt_clp)}</td>
                  <td className="mono muted">{formatClp(e.cumulative_clp)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Movements (signed CLP)</h2>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
        Positive = entrada, negative = salida.{" "}
        <span className="mono">POST /api/accounts/{id}/movements</span> con cuerpo{" "}
        <span className="mono">{"{ amount_clp, occurred_on, note? }"}</span>.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount CLP</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  No movements.
                </td>
              </tr>
            ) : (
              movements.map((m) => (
                <tr key={m.id}>
                  <td>{m.occurred_on}</td>
                  <td className="mono">{formatClp(m.amount_clp)}</td>
                  <td className="muted">{m.note ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Bolsa (depósito CLP, compra USD, dividendo USD)</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Ticker</th>
              <th>CLP</th>
              <th>USD</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {flows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No hay flujos. Usa{" "}
                  <span className="mono">POST /api/accounts/{id}/brokerage-flows</span> (body:{" "}
                  <span className="mono">flow_kind</span>, <span className="mono">amount_usd</span> o{" "}
                  <span className="mono">amount_clp</span>, <span className="mono">ticker</span>).
                </td>
              </tr>
            ) : (
              flows.map((f) => (
                <tr key={f.id}>
                  <td>{f.occurred_on}</td>
                  <td>{f.flow_kind}</td>
                  <td>{f.ticker ?? "—"}</td>
                  <td className="mono">{f.amount_clp != null ? formatClp(f.amount_clp) : "—"}</td>
                  <td className="mono">{f.amount_usd != null ? formatUsdFine(f.amount_usd) : "—"}</td>
                  <td className="muted">{f.note ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
