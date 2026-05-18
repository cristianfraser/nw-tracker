import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { densifyRecordsByCalendarDay, type ChartSparseRow } from "../chartDensifyTimeSeries";
import { AppLineChart, useMultiSeriesTrailingZeroTailClip } from "../components/AppLineChart";
import { formatClp, formatUsdFine } from "../format";
import type { MarketSeriesPoint, MarketSeriesResponse } from "../types";
import { RECHARTS_MONEY_CHART_MARGIN, buildNiceYAxisPositiveBand } from "../components/ValuationLineCharts";

type RatesTab = "fx" | "tickers";
type DisplayUnit = "clp" | "usd";

const INSTRUMENT_SLOTS = [
  { kind: "eq" as const, id: "SPY", title: "SPY" },
  { kind: "eq" as const, id: "VEA", title: "VEA" },
  { kind: "fund" as const, id: "fintual_risky_norris", title: "Risky Norris (valor cuota)" },
  { kind: "fund" as const, id: "afp_uno_cuota_a", title: "AFP Uno — valor cuota" },
  { kind: "eq" as const, id: "BTC-USD", title: "BTC" },
  { kind: "eq" as const, id: "ETH-USD", title: "ETH" },
];

function formatIpcIndex(n: number): string {
  return new Intl.NumberFormat("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(n);
}

function seriesFromPoints(
  points: MarketSeriesPoint[],
  pick: (p: MarketSeriesPoint) => number | null | undefined
): { date: string; value: number }[] {
  const rows: { date: string; value: number }[] = [];
  for (const p of points) {
    const v = pick(p);
    if (v != null && Number.isFinite(v)) rows.push({ date: p.as_of_date, value: v });
  }
  return rows;
}

function instrumentValue(
  p: MarketSeriesPoint,
  slot: (typeof INSTRUMENT_SLOTS)[number],
  display: DisplayUnit
): number | null {
  if (slot.kind === "eq") {
    return display === "clp" ? p.equity_clp[slot.id] ?? null : p.equity_usd[slot.id] ?? null;
  }
  return display === "clp" ? p.fund_unit_clp[slot.id] ?? null : p.fund_unit_usd[slot.id] ?? null;
}

function minMaxSeriesValues(data: { value: number }[]): { min: number; max: number } | null {
  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of data) {
    if (!Number.isFinite(row.value)) continue;
    minV = Math.min(minV, row.value);
    maxV = Math.max(maxV, row.value);
  }
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return null;
  return { min: minV, max: maxV };
}

function MiniLineChart({
  title,
  footnote,
  data,
  yUnit,
  valueFormatter,
}: {
  title: string;
  footnote?: string;
  data: { date: string; value: number }[];
  yUnit: "clp" | "usd" | "index";
  valueFormatter: (n: number) => string;
}) {
  const denseData = useMemo(
    () => densifyRecordsByCalendarDay(data as unknown as ChartSparseRow[], "date", ["value"]),
    [data]
  );

  const clip = useMultiSeriesTrailingZeroTailClip(
    denseData as unknown as Record<string, string | number | null>[],
    denseData.length ? { series: [{ dataKey: "value", type: "data" as const }] } : null
  );
  const chartData = clip.chartData as { date: string; value: number | null }[];
  const tailClippedKeys = clip.tailClippedKeys;

  const yBand = useMemo(() => {
    const finiteRows = chartData.filter(
      (r): r is { date: string; value: number } =>
        typeof r.value === "number" && Number.isFinite(r.value)
    );
    const mm = minMaxSeriesValues(finiteRows);
    if (!mm) return null;
    return buildNiceYAxisPositiveBand(mm.min, mm.max);
  }, [chartData]);

  const axisW = yUnit === "usd" ? 78 : yUnit === "clp" ? 104 : 62;
  if (data.length === 0) {
    return (
      <section className="rates-chart-card">
        <h3 className="rates-chart-card__title">{title}</h3>
        {footnote ? <p className="muted rates-chart-card__note">{footnote}</p> : null}
        <p className="muted rates-chart-card__empty">No data</p>
      </section>
    );
  }
  return (
    <section className="rates-chart-card">
      <h3 className="rates-chart-card__title">{title}</h3>
      {footnote ? <p className="muted rates-chart-card__note">{footnote}</p> : null}
      <div className="rates-chart-card__plot">
        <ResponsiveContainer width="100%" height="100%">
          <AppLineChart data={chartData} tailClippedKeys={tailClippedKeys} margin={{ ...RECHARTS_MONEY_CHART_MARGIN }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 10 }} tickMargin={4} minTickGap={32} />
            <YAxis
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              tickFormatter={(v) => valueFormatter(Number(v))}
              width={axisW}
              domain={yBand ? yBand.domain : ["auto", "auto"]}
              ticks={yBand ? yBand.ticks : undefined}
            />
            <Tooltip
              contentStyle={{
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
              }}
              labelStyle={{ color: "var(--muted)" }}
              formatter={(v: number | string) => [valueFormatter(Number(v)), title]}
              labelFormatter={(l) => String(l)}
            />
            <Line type="monotone" dataKey="value" stroke="var(--accent)" dot={false} strokeWidth={2} />
          </AppLineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export function RatesPage() {
  const [tab, setTab] = useState<RatesTab>("fx");
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("clp");
  const [payload, setPayload] = useState<MarketSeriesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.marketSeries();
        if (!cancelled) setPayload(d);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const points = useMemo(() => payload?.points ?? [], [payload]);

  const fxUsdClp = useMemo(() => seriesFromPoints(points, (p) => p.clp_per_usd), [points]);
  const fxUfClp = useMemo(() => seriesFromPoints(points, (p) => p.clp_per_uf), [points]);
  const fxIpc = useMemo(() => seriesFromPoints(points, (p) => p.ipc_index), [points]);
  const fxEurClp = useMemo(() => seriesFromPoints(points, (p) => p.clp_per_eur), [points]);

  if (err) {
    return (
      <main className="page">
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="page">
        <p className="muted">
          <Link to="/">← Dashboard</Link>
        </p>
        <h1>Rates</h1>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>
      <h1>Rates</h1>
      <p className="muted">
        FX tab: reference rates and IPC index. Instruments tab: SPY, VEA, Risky Norris and AFP Uno valor cuota, BTC,
        and ETH — each in CLP (via USD/CLP) or native USD per the toggle.
      </p>

      <nav className="flow-subnav" aria-label="Rates sections">
        <button type="button" className={tab === "fx" ? "active" : ""} onClick={() => setTab("fx")}>
          FX
        </button>
        <button type="button" className={tab === "tickers" ? "active" : ""} onClick={() => setTab("tickers")}>
          Tickers
        </button>
      </nav>

      {tab === "fx" ? (
        <>
          <p className="muted" style={{ marginTop: "-0.35rem", marginBottom: "1rem" }}>
            USD, UF, and EUR are CLP per one unit of foreign currency. IPC is the stored index level (not a currency).
            EUR comes from the variables sheet on import; IPC from optional <span className="mono">cfraser/ipc-index.csv</span>{" "}
            (<span className="mono">date;ipc_index</span>).
          </p>
          <div className="rates-fx-grid">
            <MiniLineChart
              title="USD / CLP"
              footnote="CLP per US$1"
              data={fxUsdClp}
              yUnit="clp"
              valueFormatter={formatClp}
            />
            <MiniLineChart
              title="UF / CLP"
              footnote="CLP per 1 UF"
              data={fxUfClp}
              yUnit="clp"
              valueFormatter={formatClp}
            />
            <MiniLineChart
              title="IPC"
              footnote="Index level (optional CSV)"
              data={fxIpc}
              yUnit="index"
              valueFormatter={formatIpcIndex}
            />
            <MiniLineChart
              title="EUR / CLP"
              footnote="CLP per €1"
              data={fxEurClp}
              yUnit="clp"
              valueFormatter={formatClp}
            />
          </div>
        </>
      ) : (
        <>
          <div className="toggle-row" style={{ alignItems: "center", flexWrap: "wrap", marginBottom: "1rem" }}>
            <span className="muted">Display: </span>
            <label>
              <input
                type="radio"
                name="rates-du"
                checked={displayUnit === "clp"}
                onChange={() => setDisplayUnit("clp")}
              />{" "}
              CLP
            </label>
            <label>
              <input type="radio" name="rates-du" checked={displayUnit === "usd"} onChange={() => setDisplayUnit("usd")} />{" "}
              USD
            </label>
            <span className="muted" style={{ marginLeft: "0.5rem" }}>
              CLP mode uses the USD/CLP series to convert USD-denominated closes; fund valor cuota stays CLP-based then
              converts to US$ in USD mode.
            </span>
          </div>

          <div className="rates-instrument-stack">
            {INSTRUMENT_SLOTS.map((slot) => {
              const data = seriesFromPoints(points, (p) => instrumentValue(p, slot, displayUnit));
              const axis: "clp" | "usd" = displayUnit === "clp" ? "clp" : "usd";
              const fmt = displayUnit === "clp" ? formatClp : formatUsdFine;
              const suffix = displayUnit === "clp" ? "CLP" : "USD";
              return (
                <MiniLineChart
                  key={`${slot.kind}:${slot.id}`}
                  title={`${slot.title} (${suffix})`}
                  data={data}
                  yUnit={axis}
                  valueFormatter={fmt}
                />
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
