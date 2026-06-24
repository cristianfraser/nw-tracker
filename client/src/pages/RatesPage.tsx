import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FxCoverageBanner } from "../components/layout/FxCoverageBanner";
import { FxBidAskGapsTable } from "../components/rates/FxBidAskGapsTable";
import { useMarketSeries, useRatesInstruments, useSyncStatus } from "../queries/hooks";
import type { DisplayUnit } from "../queries/keys";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import type { MarketDisplaySeriesRow } from "../types";
import { densifyRecordsByCalendarDay, type ChartSparseRow } from "../chartDensifyTimeSeries";
import { AppLineChart, useMultiSeriesTrailingZeroTailClip } from "../components/charts/AppLineChart";
import { Table } from "../components/ui/Table";
import { formatClp, formatUsdFine } from "../format";
import type { MarketSeriesPoint } from "../types";
import { RECHARTS_MONEY_CHART_MARGIN, buildNiceYAxisPositiveBand } from "../components/charts/ValuationLineCharts";
import { cn } from "../cn";
import { useTranslation } from "../i18n";

type RatesTab = "fx" | "tickers";

type InstrumentSlot = {
  kind: "eq" | "fund";
  id: string;
  title: string;
};

function instrumentSlotsFromDb(rows: MarketDisplaySeriesRow[] | undefined): InstrumentSlot[] {
  if (!rows?.length) {
    return [
      { kind: "eq", id: "SPY", title: "SPY" },
      { kind: "eq", id: "VEA", title: "VEA" },
      { kind: "fund", id: "fintual_cert_reserva2", title: "Reserva (valor cuota)" },
      { kind: "fund", id: "fintual_cert_risky_norris", title: "Risky Norris (valor cuota)" },
      { kind: "fund", id: "fintual_cert_apv_a", title: "Risky Norris APV (valor cuota)" },
      { kind: "fund", id: "afp_uno_cuota_a", title: "UNO-A" },
      { kind: "eq", id: "BTC-USD", title: "BTC" },
      { kind: "eq", id: "ETH-USD", title: "ETH" },
    ];
  }
  return rows.map((r) => ({
    kind: r.kind === "fund_unit" ? "fund" : "eq",
    id: r.series_key ?? r.slug,
    title: r.rates_chart_title ?? r.label,
  }));
}

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
  slot: InstrumentSlot,
  display: DisplayUnit
): number | null {
  if (slot.kind === "eq") {
    return display === "clp" ? p.equity_clp[slot.id] ?? null : p.equity_usd[slot.id] ?? null;
  }
  return display === "clp" ? p.fund_unit_clp[slot.id] ?? null : p.fund_unit_usd[slot.id] ?? null;
}

const RATES_RECENT_ROWS = 5;

function formatSeriesDateYmd(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("es-CL", { dateStyle: "short" });
}

function lastSeriesEntries(
  data: readonly { date: string; value: number }[],
  limit = RATES_RECENT_ROWS
): { date: string; value: number }[] {
  return [...data]
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

function RatesRecentEntriesTable({
  data,
  valueFormatter,
  colDate,
  colValue,
  emptyLabel,
}: {
  data: readonly { date: string; value: number }[];
  valueFormatter: (n: number) => string;
  colDate: string;
  colValue: string;
  emptyLabel: string;
}) {
  const rows = lastSeriesEntries(data);
  return (
    <div className="rates-chart-card__table">
      <Table
        header={
          <thead>
            <tr>
              <th>{colDate}</th>
              <th className="mono" style={{ textAlign: "right" }}>
                {colValue}
              </th>
            </tr>
          </thead>
        }
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={2} className="muted">
              {emptyLabel}
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.date}>
              <td className="mono">{formatSeriesDateYmd(r.date)}</td>
              <td className="mono" style={{ textAlign: "right" }}>
                {valueFormatter(r.value)}
              </td>
            </tr>
          ))
        )}
      </Table>
    </div>
  );
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

function mergeFxUsdDualSeries(
  yahoo: readonly { date: string; value: number }[],
  bcentral: readonly { date: string; value: number }[],
  buy: readonly { date: string; value: number }[] = [],
  sell: readonly { date: string; value: number }[] = []
): { date: string; yahoo: number | null; bcentral: number | null; buy: number | null; sell: number | null }[] {
  const dates = new Set<string>();
  for (const r of yahoo) dates.add(r.date);
  for (const r of bcentral) dates.add(r.date);
  for (const r of buy) dates.add(r.date);
  for (const r of sell) dates.add(r.date);
  const ym = new Map(yahoo.map((r) => [r.date, r.value]));
  const bm = new Map(bcentral.map((r) => [r.date, r.value]));
  const buyM = new Map(buy.map((r) => [r.date, r.value]));
  const sellM = new Map(sell.map((r) => [r.date, r.value]));
  return [...dates]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => ({
      date,
      yahoo: ym.get(date) ?? null,
      bcentral: bm.get(date) ?? null,
      buy: buyM.get(date) ?? null,
      sell: sellM.get(date) ?? null,
    }));
}

function fxUsdSeriesLabel(
  name: string,
  labels: { yahoo: string; bcentral: string; buy: string; sell: string }
): string {
  switch (name) {
    case "yahoo":
      return labels.yahoo;
    case "bcentral":
      return labels.bcentral;
    case "buy":
      return labels.buy;
    case "sell":
      return labels.sell;
    default:
      return name;
  }
}

function FxUsdClpDualChart({
  yahooData,
  bcentralData,
  buyData = [],
  sellData = [],
  yahooLabel,
  bcentralLabel,
  buyLabel,
  sellLabel,
  recentColDate,
  recentColValue,
  recentEmptyLabel,
}: {
  yahooData: { date: string; value: number }[];
  bcentralData: { date: string; value: number }[];
  buyData?: { date: string; value: number }[];
  sellData?: { date: string; value: number }[];
  yahooLabel: string;
  bcentralLabel: string;
  buyLabel: string;
  sellLabel: string;
  recentColDate: string;
  recentColValue: string;
  recentEmptyLabel: string;
}) {
  const seriesLabels = { yahoo: yahooLabel, bcentral: bcentralLabel, buy: buyLabel, sell: sellLabel };
  const merged = useMemo(
    () => mergeFxUsdDualSeries(yahooData, bcentralData, buyData, sellData),
    [yahooData, bcentralData, buyData, sellData]
  );
  const denseData = useMemo(
    () =>
      densifyRecordsByCalendarDay(
        merged as unknown as ChartSparseRow[],
        "date",
        ["yahoo", "bcentral", "buy", "sell"]
      ),
    [merged]
  );

  const clip = useMultiSeriesTrailingZeroTailClip(
    denseData as unknown as Record<string, string | number | null>[],
    denseData.length
      ? {
          series: [
            { dataKey: "yahoo", type: "data" as const },
            { dataKey: "bcentral", type: "data" as const },
            { dataKey: "buy", type: "data" as const },
            { dataKey: "sell", type: "data" as const },
          ],
        }
      : null
  );
  const chartData = clip.chartData as {
    date: string;
    yahoo: number | null;
    bcentral: number | null;
    buy: number | null;
    sell: number | null;
  }[];
  const tailClippedKeys = clip.tailClippedKeys;

  const yBand = useMemo(() => {
    const values: number[] = [];
    for (const r of chartData) {
      for (const key of ["yahoo", "bcentral", "buy", "sell"] as const) {
        const v = r[key];
        if (typeof v === "number" && Number.isFinite(v)) values.push(v);
      }
    }
    const mm = minMaxSeriesValues(values.map((value) => ({ value })));
    if (!mm) return null;
    return buildNiceYAxisPositiveBand(mm.min, mm.max);
  }, [chartData]);

  const recentTable = (
    <RatesRecentEntriesTable
      data={yahooData}
      valueFormatter={formatClp}
      colDate={recentColDate}
      colValue={recentColValue}
      emptyLabel={recentEmptyLabel}
    />
  );

  if (yahooData.length === 0 && bcentralData.length === 0) {
    return (
      <section className="rates-chart-card">
        <h3 className="rates-chart-card__title">USD / CLP</h3>
        <p className="muted rates-chart-card__note">CLP per US$1</p>
        <p className="muted rates-chart-card__empty">No data</p>
        {recentTable}
      </section>
    );
  }

  return (
    <section className="rates-chart-card">
      <h3 className="rates-chart-card__title">USD / CLP</h3>
      <p className="muted rates-chart-card__note">CLP per US$1</p>
      <div className="rates-chart-card__plot">
        <ResponsiveContainer width="100%" height="100%">
          <AppLineChart data={chartData} tailClippedKeys={tailClippedKeys} margin={{ ...RECHARTS_MONEY_CHART_MARGIN }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 10 }} tickMargin={4} minTickGap={32} />
            <YAxis
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              tickFormatter={(v) => formatClp(Number(v))}
              width={104}
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
              formatter={(v: number | string, name: string) => [
                formatClp(Number(v)),
                fxUsdSeriesLabel(name, seriesLabels),
              ]}
              labelFormatter={(l) => String(l)}
            />
            <Line type="monotone" dataKey="yahoo" name="yahoo" stroke="var(--accent)" dot={false} strokeWidth={2} />
            <Line
              type="monotone"
              dataKey="bcentral"
              name="bcentral"
              stroke="var(--muted)"
              dot={false}
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {buyData.length > 0 ? (
              <Line
                type="monotone"
                dataKey="buy"
                name="buy"
                stroke="#22c55e"
                dot={{ r: 3 }}
                strokeWidth={1.5}
              />
            ) : null}
            {sellData.length > 0 ? (
              <Line
                type="monotone"
                dataKey="sell"
                name="sell"
                stroke="#f97316"
                dot={{ r: 3 }}
                strokeWidth={1.5}
              />
            ) : null}
          </AppLineChart>
        </ResponsiveContainer>
      </div>
      {recentTable}
    </section>
  );
}

function MiniLineChart({
  title,
  footnote,
  data,
  yUnit,
  valueFormatter,
  recentColDate,
  recentColValue,
  recentEmptyLabel,
}: {
  title: string;
  footnote?: string;
  data: { date: string; value: number }[];
  yUnit: "clp" | "usd" | "index";
  valueFormatter: (n: number) => string;
  recentColDate: string;
  recentColValue: string;
  recentEmptyLabel: string;
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
  const recentTable = (
    <RatesRecentEntriesTable
      data={data}
      valueFormatter={valueFormatter}
      colDate={recentColDate}
      colValue={recentColValue}
      emptyLabel={recentEmptyLabel}
    />
  );

  if (data.length === 0) {
    return (
      <section className="rates-chart-card">
        <h3 className="rates-chart-card__title">{title}</h3>
        {footnote ? <p className="muted rates-chart-card__note">{footnote}</p> : null}
        <p className="muted rates-chart-card__empty">No data</p>
        {recentTable}
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
      {recentTable}
    </section>
  );
}

export function RatesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RatesTab>("fx");
  const { displayUnit } = useDisplayPreferences();
  const { data: payload, error } = useMarketSeries();
  const { data: syncStatus } = useSyncStatus();
  const { data: ratesInstruments } = useRatesInstruments();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const instrumentSlots = useMemo(
    () => instrumentSlotsFromDb(ratesInstruments?.instruments),
    [ratesInstruments]
  );

  const points = useMemo(() => payload?.points ?? [], [payload]);

  const fxUsdClp = useMemo(() => payload?.fx_usd_clp ?? [], [payload]);
  const fxUsdClpBcentral = useMemo(() => payload?.fx_usd_clp_bcentral ?? [], [payload]);
  const fxUsdClpBuy = useMemo(() => payload?.fx_usd_clp_buy ?? [], [payload]);
  const fxUsdClpSell = useMemo(() => payload?.fx_usd_clp_sell ?? [], [payload]);
  const fxUfClp = useMemo(() => seriesFromPoints(points, (p) => p.clp_per_uf), [points]);
  const fxIpc = useMemo(() => seriesFromPoints(points, (p) => p.ipc_index), [points]);
  const fxEurClp = useMemo(() => payload?.eur_clp ?? [], [payload]);

  const fxSyncStale = useMemo(() => {
    const stale = syncStatus?.stale ?? [];
    return stale.includes("yahoo_fx_usd") || stale.includes("sbif_usd") || stale.includes("sbif_eur");
  }, [syncStatus]);

  const recentColDate = t("rates.recentColDate");
  const recentColValue = t("rates.recentColValue");
  const recentEmptyLabel = t("rates.recentEmpty");
  const recentTableProps = { recentColDate, recentColValue, recentEmptyLabel };

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!payload) {
    return (
      <main>
        <p className="muted">
          <Link to="/">{t("common.backToDashboard")}</Link>
        </p>
        <h1>{t("rates.pageTitle")}</h1>
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main>
      <p className="muted">
        <Link to="/">{t("common.backToDashboard")}</Link>
      </p>
      <h1>{t("rates.pageTitle")}</h1>
      <FxCoverageBanner coverage={payload.fx_coverage} />
      {fxSyncStale ? (
        <p className="error" role="alert" style={{ maxWidth: "58rem", marginBottom: "1rem" }}>
          {t("fxCoverage.syncStale")}
        </p>
      ) : null}
      <p className="muted">
        FX tab: reference rates and IPC index. Instruments tab: SPY, VEA, Reserva valor cuota, Risky Norris valor
        cuota, Risky Norris APV valor cuota, UNO-A, BTC, and ETH — each in CLP (via USD/CLP) or native
        USD per the toggle.
      </p>

      <nav className="flow-subnav" aria-label={t("rates.subnavAria")}>
        <button type="button" className={cn(tab === "fx" && "active")} onClick={() => setTab("fx")}>
          {t("rates.tabFx")}
        </button>
        <button type="button" className={cn(tab === "tickers" && "active")} onClick={() => setTab("tickers")}>
          {t("rates.tabTickers")}
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
            <FxUsdClpDualChart
              yahooData={fxUsdClp}
              bcentralData={fxUsdClpBcentral}
              buyData={fxUsdClpBuy}
              sellData={fxUsdClpSell}
              yahooLabel={t("rates.fx.yahoo")}
              bcentralLabel={t("rates.fx.bcentralObservado")}
              buyLabel={t("rates.fx.buy")}
              sellLabel={t("rates.fx.sell")}
              recentColDate={recentColDate}
              recentColValue={recentColValue}
              recentEmptyLabel={recentEmptyLabel}
            />
            <MiniLineChart
              title="UF / CLP"
              footnote="CLP per 1 UF"
              data={fxUfClp}
              yUnit="clp"
              valueFormatter={formatClp}
              {...recentTableProps}
            />
            <MiniLineChart
              title="IPC"
              footnote="Index level (optional CSV)"
              data={fxIpc}
              yUnit="index"
              valueFormatter={formatIpcIndex}
              {...recentTableProps}
            />
            <MiniLineChart
              title="EUR / CLP"
              footnote="CLP per €1"
              data={fxEurClp}
              yUnit="clp"
              valueFormatter={formatClp}
              {...recentTableProps}
            />
          </div>
          <FxBidAskGapsTable />
        </>
      ) : (
        <>
          <p className="muted" style={{ marginBottom: "1rem", maxWidth: "52rem", lineHeight: 1.45 }}>
            {t("rates.instrumentDisplayHint")}
          </p>

          <div className="rates-instrument-stack">
            {instrumentSlots.map((slot) => {
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
                  {...recentTableProps}
                />
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
