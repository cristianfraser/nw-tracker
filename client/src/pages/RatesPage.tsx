import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FxCoverageBanner } from "../components/layout/FxCoverageBanner";
import { FxBidAskGapsTable } from "../components/rates/FxBidAskGapsTable";
import { useMarketSeries, useRatesInstruments, useSyncStatus } from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import type { MarketDisplaySeriesRow } from "../types";
import { densifyRecordsByCalendarDay, type ChartSparseRow } from "../chartDensifyTimeSeries";
import { RatesLineChart, type RatesLineSeries } from "../components/charts/RatesLineChart";
import { useDailyRateTailClip } from "./ratesDailyTailClip";
import { clipRowsToTimeRange, type TimeRange } from "../timeRange";

const FX_USD_DUAL_SERIES_KEYS = ["yahoo", "bcentral", "buy", "sell"] as const;
const SINGLE_VALUE_SERIES_KEYS = ["value"] as const;
import { Table } from "../components/ui/Table";
import { loadableClass } from "../components/ui/Loadable";
import { currencyFormatInfo, formatClp, formatCurrencyFine, formatGroupedDecimal } from "../format";
import type { MarketSeriesPoint } from "../types";
import { buildNiceYAxisPositiveBand } from "../components/charts/chartLayout";
import { useTranslation } from "../i18n";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import { DASHBOARD_PATH } from "../dashboardPath";

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
  return formatGroupedDecimal(n, 1, 2);
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

/** The slot's value on a point, already in the payload's unit (server-converted). */
function instrumentValue(p: MarketSeriesPoint, slot: InstrumentSlot): number | null {
  return (slot.kind === "eq" ? p.equity[slot.id] : p.fund_unit[slot.id]) ?? null;
}

const RATES_RECENT_ROWS = 5;

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
  loading,
}: {
  data: readonly { date: string; value: number }[];
  valueFormatter: (n: number) => string;
  colDate: string;
  colValue: string;
  emptyLabel: string;
  loading?: boolean;
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
          loading ? null : (
            <tr>
              <td colSpan={2} className="muted">
                {emptyLabel}
              </td>
            </tr>
          )
        ) : (
          rows.map((r) => (
            <tr key={r.date}>
              <td className="mono">{r.date}</td>
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

function FxUsdClpDualChart({
  timeRange,
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
  loading,
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
  timeRange: TimeRange;
  loading?: boolean;
}) {
  const merged = useMemo(
    () => mergeFxUsdDualSeries(yahooData, bcentralData, buyData, sellData),
    [yahooData, bcentralData, buyData, sellData]
  );
  const denseData = useMemo(() => {
    const clipped = clipRowsToTimeRange(merged, timeRange, (r) => r.date);
    return densifyRecordsByCalendarDay(clipped as unknown as ChartSparseRow[], "date", [
      "yahoo",
      "bcentral",
      "buy",
      "sell",
    ]);
  }, [merged, timeRange]);

  const clip = useDailyRateTailClip(
    denseData as unknown as Record<string, string | number | null>[],
    FX_USD_DUAL_SERIES_KEYS
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
      loading={loading}
    />
  );

  if (yahooData.length === 0 && bcentralData.length === 0) {
    return (
      <section className={loadableClass(loading, "rates-chart-card", "chart-grid__col")}>
        <h3 className="rates-chart-card__title">USD / CLP</h3>
        <p className="muted rates-chart-card__note">CLP per US$1</p>
        {loading ? (
          <div className="rates-chart-card__plot" aria-busy="true" />
        ) : (
          <p className="muted rates-chart-card__empty">No data</p>
        )}
        {recentTable}
      </section>
    );
  }

  return (
    <section className={loadableClass(loading, "rates-chart-card", "chart-grid__col")}>
      <h3 className="rates-chart-card__title">USD / CLP</h3>
      <p className="muted rates-chart-card__note">CLP per US$1</p>
      <div className="rates-chart-card__plot">
        <RatesLineChart
          data={chartData}
          tailClippedKeys={tailClippedKeys}
          yAxisWidth={104}
          yBand={yBand}
          formatValue={formatClp}
          series={[
            { dataKey: "yahoo", name: yahooLabel, stroke: "var(--accent)" },
            {
              dataKey: "bcentral",
              name: bcentralLabel,
              stroke: "var(--muted)",
              strokeWidth: 1.5,
              strokeDasharray: "4 3",
            },
            ...(buyData.length > 0
              ? [{ dataKey: "buy", name: buyLabel, stroke: "#22c55e", strokeWidth: 1.5, dot: { r: 3 } } satisfies RatesLineSeries]
              : []),
            ...(sellData.length > 0
              ? [{ dataKey: "sell", name: sellLabel, stroke: "#f97316", strokeWidth: 1.5, dot: { r: 3 } } satisfies RatesLineSeries]
              : []),
          ]}
        />
      </div>
      {recentTable}
    </section>
  );
}

function MiniLineChart({
  timeRange,
  title,
  footnote,
  data,
  yUnit,
  valueFormatter,
  recentColDate,
  recentColValue,
  recentEmptyLabel,
  loading,
}: {
  title: string;
  footnote?: string;
  data: { date: string; value: number }[];
  /** A currency code for money axes, or `index` for a unitless level. */
  yUnit: string;
  valueFormatter: (n: number) => string;
  recentColDate: string;
  recentColValue: string;
  recentEmptyLabel: string;
  timeRange: TimeRange;
  loading?: boolean;
}) {
  const denseData = useMemo(() => {
    const clipped = clipRowsToTimeRange(data, timeRange, (r) => r.date);
    return densifyRecordsByCalendarDay(clipped as unknown as ChartSparseRow[], "date", ["value"]);
  }, [data, timeRange]);

  const clip = useDailyRateTailClip(
    denseData as unknown as Record<string, string | number | null>[],
    SINGLE_VALUE_SERIES_KEYS
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

  // Whole-unit currencies (pesos) carry more digits on the axis than ones with cents.
  const axisW = yUnit === "index" ? 62 : currencyFormatInfo(yUnit).minorDigits === 0 ? 104 : 78;
  const recentTable = (
    <RatesRecentEntriesTable
      data={data}
      valueFormatter={valueFormatter}
      colDate={recentColDate}
      colValue={recentColValue}
      emptyLabel={recentEmptyLabel}
      loading={loading}
    />
  );

  if (data.length === 0) {
    return (
      <section className={loadableClass(loading, "rates-chart-card", "chart-grid__col")}>
        <h3 className="rates-chart-card__title">{title}</h3>
        {footnote ? <p className="muted rates-chart-card__note">{footnote}</p> : null}
        {loading ? (
          <div className="rates-chart-card__plot" aria-busy="true" />
        ) : (
          <p className="muted rates-chart-card__empty">No data</p>
        )}
        {recentTable}
      </section>
    );
  }
  return (
    <section className={loadableClass(loading, "rates-chart-card", "chart-grid__col")}>
      <h3 className="rates-chart-card__title">{title}</h3>
      {footnote ? <p className="muted rates-chart-card__note">{footnote}</p> : null}
      <div className="rates-chart-card__plot">
        <RatesLineChart
          data={chartData}
          tailClippedKeys={tailClippedKeys}
          yAxisWidth={axisW}
          yBand={yBand}
          formatValue={valueFormatter}
          series={[{ dataKey: "value", name: title, stroke: "var(--accent)" }]}
        />
      </div>
      {recentTable}
    </section>
  );
}

export function RatesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RatesTab>("fx");
  const { displayUnit } = useDisplayPreferences();
  // Range-only per-surface control (rates are daily-native): one Rango for every panel.
  const rangePrefs = useSurfacePrefs("rates.range", "month", "1y");
  const seriesQuery = useMarketSeries(displayUnit);
  const { data: payload, error: queryError } = seriesQuery;
  // Dim while there is no payload yet or the previous unit's is held.
  const seriesPending = queryShowsLoading(seriesQuery);
  const error = queryLoadError({ data: payload, error: queryError });
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

  return (
    <main>
      <p className="muted">
        <Link to={DASHBOARD_PATH}>{t("common.backToDashboard")}</Link>
      </p>
      <h1>{t("rates.pageTitle")}</h1>
      <FxCoverageBanner coverage={payload?.fx_coverage} />
      {fxSyncStale ? (
        <p className="error" role="alert" style={{ maxWidth: "58rem" }}>
          {t("fxCoverage.syncStale")}
        </p>
      ) : null}

      <nav className="flow-subnav" aria-label={t("rates.subnavAria")}>
        <button type="button" onClick={() => setTab("fx")}>
          {t("rates.tabFx")}
        </button>
        <button type="button" onClick={() => setTab("tickers")}>
          {t("rates.tabTickers")}
        </button>
      </nav>

      <div className="page-tile--end">
        <SurfaceControls range={rangePrefs.range} onRangeChange={rangePrefs.setRange} />
      </div>

      {tab === "fx" ? (
        <>
          <div className="chart-grid">
            <FxUsdClpDualChart
              timeRange={rangePrefs.range}
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
              loading={seriesPending}
            />
            <MiniLineChart
              timeRange={rangePrefs.range}
              title="UF / CLP"
              footnote="CLP per 1 UF"
              data={fxUfClp}
              yUnit="clp"
              valueFormatter={formatClp}
              {...recentTableProps}
              loading={seriesPending}
            />
            <MiniLineChart
              timeRange={rangePrefs.range}
              title="IPC"
              footnote="Index level (optional CSV)"
              data={fxIpc}
              yUnit="index"
              valueFormatter={formatIpcIndex}
              {...recentTableProps}
              loading={seriesPending}
            />
            <MiniLineChart
              timeRange={rangePrefs.range}
              title="EUR / CLP"
              footnote="CLP per €1"
              data={fxEurClp}
              yUnit="clp"
              valueFormatter={formatClp}
              {...recentTableProps}
              loading={seriesPending}
            />
          </div>
          <FxBidAskGapsTable />
        </>
      ) : (
        <>
          <div className="chart-grid chart-grid--full-line">
            {instrumentSlots.map((slot) => {
              const data = seriesFromPoints(points, (p) => instrumentValue(p, slot));
              // The unit the values are in: the payload's (a held one keeps its own while the next loads).
              const unit = payload?.unit ?? displayUnit;
              const fmt = (n: number) => formatCurrencyFine(n, unit);
              const suffix = unit.toUpperCase();
              return (
                <MiniLineChart
                  timeRange={rangePrefs.range}
                  key={`${slot.kind}:${slot.id}`}
                  title={`${slot.title} (${suffix})`}
                  data={data}
                  yUnit={unit}
                  valueFormatter={fmt}
                  {...recentTableProps}
                  loading={seriesPending}
                />
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
