import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Legend, Line, XAxis, YAxis } from "recharts";
import { PageGridTile } from "../components/layout/PageGridTile";
import { AppLineChart } from "../components/charts/AppLineChart";
import { ChartEmptyState } from "../components/charts/ChartEmptyState";
import { minMaxForKeys } from "../components/charts/chartLayout";
import { percentileLogAxisFor, topPercentOf } from "../components/charts/percentileLogAxis";
import { Loadable, loadableClass } from "../components/ui/Loadable";
import { ColumnTable, type TableColumn } from "../components/ui/ColumnTable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatCurrency, formatGroupedDecimal } from "../format";
import { useWealthPercentile } from "../queries/hooks";
import type {
  WealthBenchmarkCountry,
  WealthPercentileCell,
  WealthPercentileYearRow,
} from "../types";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import type { DisplayUnit } from "../queries/keys";

const BENCHMARK_COUNTRIES: readonly WealthBenchmarkCountry[] = [
  "US",
  "ES",
  "CH",
  "UK",
  "AU",
  "DE",
  "JP",
  "MX",
  "BR",
  "CN",
];

/** Benchmarks shown out of the box; the settings section below the page toggles the full list. */
const DEFAULT_ENABLED_BENCHMARKS: readonly WealthBenchmarkCountry[] = ["US", "AU", "DE", "MX"];

const ENABLED_BENCHMARKS_STORAGE_KEY = "nw-tracker.wealth-percentile.countries";

function loadEnabledBenchmarks(): WealthBenchmarkCountry[] {
  try {
    const raw = localStorage.getItem(ENABLED_BENCHMARKS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_ENABLED_BENCHMARKS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_ENABLED_BENCHMARKS];
    return BENCHMARK_COUNTRIES.filter((c) => (parsed as string[]).includes(c));
  } catch {
    return [...DEFAULT_ENABLED_BENCHMARKS];
  }
}

/** Distinct hues from the app palette families; the CL pair below is white/light-gray, so no grays here. */
const BENCHMARK_STROKE: Record<WealthBenchmarkCountry, string> = {
  US: "#22c55e",
  ES: "#eab308",
  CH: "#ec4899",
  UK: "#a78bfa",
  AU: "#fb923c",
  DE: "#38bdf8",
  JP: "#f87171",
  MX: "#2dd4bf",
  BR: "#e879f9",
  CN: "#fcd34d",
};

/** The two CL lines share one neutral hue (white/light-gray) so benchmarks carry the color. */
const CL_TOTAL_STROKE = "#ffffff";
const CL_FINANCIAL_STROKE = "#94a3b8";

type ScaleMode = "linear" | "log";
const SCALE_MODES: readonly ScaleMode[] = ["linear", "log"];

type ThresholdKey = "p50" | "p90" | "p99";
/** Richest-first order for the stacked country-table cells (p99 on top). */
const THRESHOLD_KEYS_DESC: readonly ThresholdKey[] = ["p99", "p90", "p50"];

/** `*` databook lag · `†` interpolated 2023/24 · `‡` own 2025 reconstruction. */
function yearMarkers(row: WealthPercentileYearRow): string {
  return [
    row.distribution_year < row.year ? "*" : "",
    row.interpolated ? "†" : "",
    row.reconstructed ? "‡" : "",
  ].join("");
}

/** The threshold in the payload's unit (server-converted at the row's year-end rate). */
function thresholdOf(cell: WealthPercentileCell, key: ThresholdKey): number {
  return key === "p50" ? cell.p50 : key === "p90" ? cell.p90 : cell.p99;
}

function rowsDescOf(rows: readonly WealthPercentileYearRow[]): WealthPercentileYearRow[] {
  return [...rows].sort((a, b) => b.year - a.year);
}

/** Año | Patr. financiero | %CL fin. | Patrimonio | %CL | benchmark columns (today's percentile, desc). */
function MyDataTable({
  rows,
  countries,
  unit,
  loading,
}: {
  rows: readonly WealthPercentileYearRow[];
  countries: readonly WealthBenchmarkCountry[];
  /** The unit the rows' amounts are in (the payload's). */
  unit: DisplayUnit;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const money = (n: number) => formatCurrency(n, unit);
  const pctText = (cell: WealthPercentileCell) =>
    cell.below_support
      ? t("wealthPercentile.belowSupport")
      : formatGroupedDecimal(cell.percentile ?? Number.NaN, 1);

  const columns: TableColumn<WealthPercentileYearRow>[] = [
    { key: "year", header: t("wealthPercentile.table.year"), className: "mono", cell: (row) => `${row.year}${yearMarkers(row)}`, title: true },
    {
      key: "finNetWorth",
      header: t("wealthPercentile.table.finNetWorth"),
      className: "mono",
      cell: (row) => money(row.fin_net_worth),
    },
    { key: "clFin", header: "%CL fin.", className: "mono", cell: (row) => pctText(row.cl_financial) },
    {
      key: "netWorth",
      header: t("wealthPercentile.table.netWorth"),
      className: "mono",
      cell: (row) => money(row.net_worth),
    },
    { key: "cl", header: "%CL", className: "mono", cell: (row) => pctText(row.cl_total) },
    ...countries.map(
      (c): TableColumn<WealthPercentileYearRow> => ({
        key: c,
        header: `%${c}`,
        className: "mono",
        cell: (row) => pctText(row.benchmarks[c]),
      })
    ),
  ];

  return (
    <ColumnTable
      rows={rowsDescOf(rows)}
      columns={columns}
      rowKey={(row) => row.year}
      wrapClassName={loadableClass(loading)}
      cardLayout="flat"
    />
  );
}

const THRESHOLD_PERCENTILE: Record<ThresholdKey, number> = { p50: 50, p90: 90, p99: 99 };

/**
 * Own percentile label, truncated (never rounded up) so it cannot read as the threshold above it:
 * 98,96 is «p98,9», not «p99,0». Two decimals above p99, where one would show «p99,9» for 99,96.
 */
function ownPercentileLabel(percentile: number): string {
  const decimals = percentile >= 99 ? 2 : 1;
  const factor = 10 ** decimals;
  return `p${formatGroupedDecimal(Math.floor(percentile * factor) / factor, decimals)}`;
}

/**
 * p99/p90/p50 stacked for one distribution cell, with the user's own net worth for that year inserted
 * where its percentile falls (above p99, between two thresholds, or below p50) and highlighted.
 */
function ThresholdPairsCell({
  cell,
  own,
  unit,
}: {
  cell: WealthPercentileCell;
  /** The user's net worth for the cell's mode, in `unit`. */
  own: number;
  unit: DisplayUnit;
}) {
  const { t } = useTranslation();
  const ownValue = formatCurrency(own, unit);
  const ownLine = (
    <span key="own" className="wealth-own-threshold" style={{ whiteSpace: "nowrap" }}>
      {`${cell.below_support || cell.percentile === null ? t("wealthPercentile.belowSupport") : ownPercentileLabel(cell.percentile)}: ${ownValue}`}
    </span>
  );
  const lines: ReactNode[] = [];
  let ownPlaced = false;
  for (const k of THRESHOLD_KEYS_DESC) {
    if (!ownPlaced && cell.percentile !== null && cell.percentile >= THRESHOLD_PERCENTILE[k]) {
      lines.push(ownLine);
      ownPlaced = true;
    }
    lines.push(
      <span key={k} style={{ whiteSpace: "nowrap" }}>
        {`${k}: ${formatCurrency(thresholdOf(cell, k), unit)}`}
      </span>
    );
  }
  if (!ownPlaced) lines.push(ownLine);
  return <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>{lines}</div>;
}

/**
 * Año | CL fin. | CL | benchmark columns (same order as MyDataTable) — p99/p90/p50 per cell plus the
 * user's own line for that year. The CL fin. column (Chile financial-wealth distribution, ex real
 * estate) places the year's FINANCIAL net worth; total-mode columns place the year's total net worth.
 */
function CountryDataTable({
  rows,
  countries,
  unit,
  loading,
}: {
  rows: readonly WealthPercentileYearRow[];
  countries: readonly WealthBenchmarkCountry[];
  unit: DisplayUnit;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const pairs = (cell: WealthPercentileCell, own: number) => (
    <ThresholdPairsCell cell={cell} own={own} unit={unit} />
  );

  const columns: TableColumn<WealthPercentileYearRow>[] = [
    {
      key: "year",
      header: t("wealthPercentile.table.year"),
      className: "mono",
      cellProps: () => ({ style: { verticalAlign: "top" } }),
      cell: (row) => `${row.year}${yearMarkers(row)}`,
      title: true,
    },
    {
      key: "clFin",
      header: "CL fin.",
      className: "mono",
      cell: (row) => pairs(row.cl_financial, row.fin_net_worth),
    },
    { key: "cl", header: "CL", className: "mono", cell: (row) => pairs(row.cl_total, row.net_worth) },
    ...countries.map(
      (c): TableColumn<WealthPercentileYearRow> => ({
        key: c,
        header: c,
        className: "mono",
        cell: (row) => pairs(row.benchmarks[c], row.net_worth),
      })
    ),
  ];

  return (
    <ColumnTable
      rows={rowsDescOf(rows)}
      columns={columns}
      rowKey={(row) => row.year}
      wrapClassName={loadableClass(loading)}
      cardLayout="flat"
    />
  );
}

function MarkerLegend({ rows }: { rows: readonly WealthPercentileYearRow[] }) {
  const { t } = useTranslation();
  const lagged = rows.filter((r) => r.distribution_year < r.year);
  const hasInterpolated = rows.some((r) => r.interpolated);
  const hasReconstructed = rows.some((r) => r.reconstructed);
  if (!lagged.length && !hasInterpolated && !hasReconstructed) return null;
  return (
    <p className="muted" style={{ fontSize: "0.8em" }}>
      {lagged.length > 0 ? (
        <span style={{ display: "block" }}>
          {t("wealthPercentile.markers.distributionYear", {
            year: Math.max(...lagged.map((r) => r.distribution_year)),
          })}
        </span>
      ) : null}
      {hasInterpolated ? (
        <span style={{ display: "block" }}>{t("wealthPercentile.markers.interpolated")}</span>
      ) : null}
      {hasReconstructed ? (
        <span style={{ display: "block" }}>{t("wealthPercentile.markers.reconstructed")}</span>
      ) : null}
    </p>
  );
}

export function WealthPercentilePage() {
  const { t } = useTranslation();
  const [scaleMode, setScaleMode] = useState<ScaleMode>("log");
  const [enabledBenchmarks, setEnabledBenchmarks] = useState<WealthBenchmarkCountry[]>(
    loadEnabledBenchmarks
  );
  const { displayUnit } = useDisplayPreferences();
  const wealthQuery = useWealthPercentile(displayUnit);
  const { data, error: queryError } = wealthQuery;
  const error = queryLoadError({ data, error: queryError });
  // Dim while nothing has loaded or the previous unit's payload is held (shown in its own unit).
  const loading = queryShowsLoading(wealthQuery);
  const amountsUnit = data?.unit ?? displayUnit;

  const toggleBenchmark = (country: WealthBenchmarkCountry) => {
    setEnabledBenchmarks((prev) => {
      const set = new Set(prev);
      if (set.has(country)) set.delete(country);
      else set.add(country);
      const next = BENCHMARK_COUNTRIES.filter((c) => set.has(c));
      localStorage.setItem(ENABLED_BENCHMARKS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Series plotted in both chart modes (percentile in linear mode, top-% in log mode).
  const chartSeriesKeys = useMemo(
    () => ["total", "financial", ...enabledBenchmarks.map((c) => c.toLowerCase())],
    [enabledBenchmarks]
  );

  // Raw numbers only — formatting happens at render time (separator/language toggles).
  const chartPoints = useMemo(
    () =>
      (data?.rows ?? []).map((r) => {
        const p: Record<string, string | number | null> = {
          year: String(r.year),
          total: r.cl_total.percentile,
          financial: r.cl_financial.percentile,
        };
        for (const c of enabledBenchmarks) p[c.toLowerCase()] = r.benchmarks[c].percentile;
        return p;
      }),
    [data, enabledBenchmarks]
  );

  // Log mode plots "top X%" (100 − percentile) on a reversed-log axis so the crowded 90–100 band opens up.
  const logChartPoints = useMemo(
    () =>
      chartPoints.map((p) => {
        const out: Record<string, string | number | null> = { year: p.year };
        for (const k of chartSeriesKeys) {
          const v = p[k];
          out[k] = typeof v === "number" ? topPercentOf(v) : null;
        }
        return out;
      }),
    [chartPoints, chartSeriesKeys]
  );
  const logAxis = useMemo(
    () => percentileLogAxisFor(minMaxForKeys(logChartPoints, chartSeriesKeys).min),
    [logChartPoints, chartSeriesKeys]
  );

  if (error) {
    return (
      <main>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }

  const rows = data?.rows ?? [];
  // Column order comes from the latest row (current year, valued as of today).
  const latestRow = rows.length ? rows.reduce((m, r) => (r.year > m.year ? r : m)) : null;
  // Enabled benchmark columns ordered by today's percentile, highest first (easiest country → hardest).
  const benchmarkOrder: readonly WealthBenchmarkCountry[] = latestRow
    ? [...enabledBenchmarks].sort(
        (a, b) =>
          (latestRow.benchmarks[b].percentile ?? -1) - (latestRow.benchmarks[a].percentile ?? -1)
      )
    : enabledBenchmarks;

  return (
    <main>
      <h1>{t("wealthPercentile.title")}</h1>

      <PageGridTile id="chart">
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
        >
          <span className="muted" style={{ fontSize: "0.85em" }}>
            {t("wealthPercentile.chart.scaleLabel")}
          </span>
          <select value={scaleMode} onChange={(e) => setScaleMode(e.target.value as ScaleMode)}>
            {SCALE_MODES.map((m) => (
              <option key={m} value={m}>
                {m === "log" ? t("wealthPercentile.chart.scaleLog") : t("wealthPercentile.chart.scaleLinear")}
              </option>
            ))}
          </select>
        </label>

        {chartPoints.length === 0 ? (
          <ChartEmptyState loading={loading} message={t("wealthPercentile.empty")} />
        ) : (
          <Loadable loading={loading} style={{ width: "100%", height: 320 }}>
            <AppLineChart
              data={scaleMode === "log" ? logChartPoints : chartPoints}
              tooltip={{
                formatValue: (v) =>
                  formatGroupedDecimal(scaleMode === "log" ? 100 - Number(v) : Number(v), 1),
                formatLabel: (l) => String(l),
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="year" tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={20} />
              {scaleMode === "log" ? (
                <YAxis
                  scale="log"
                  reversed
                  domain={logAxis.domain}
                  ticks={logAxis.ticks}
                  allowDataOverflow
                  tickFormatter={(v: number) => {
                    const p = 100 - v;
                    return formatGroupedDecimal(p, Number.isInteger(p) ? 0 : 1);
                  }}
                  tick={{ fill: "var(--muted)", fontSize: 10 }}
                  width={34}
                />
              ) : (
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tick={{ fill: "var(--muted)", fontSize: 10 }}
                  width={30}
                />
              )}
              <Legend itemSorter={null} />
              <Line
                type="monotone"
                dataKey="total"
                name={t("wealthPercentile.chart.seriesTotal")}
                stroke={CL_TOTAL_STROKE}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="financial"
                name={t("wealthPercentile.chart.seriesFinancial")}
                stroke={CL_FINANCIAL_STROKE}
                strokeWidth={2}
                dot={false}
              />
              {benchmarkOrder.map((c) => (
                <Line
                  key={c}
                  type="monotone"
                  dataKey={c.toLowerCase()}
                  name={t("wealthPercentile.chart.seriesBenchmark", { country: c })}
                  stroke={BENCHMARK_STROKE[c]}
                  strokeWidth={1.5}
                  dot={false}
                />
              ))}
            </AppLineChart>
          </Loadable>
        )}
      </PageGridTile>

      <PageGridTile id="my-data">
        <h2>{t("wealthPercentile.tables.myData")}</h2>
        <MyDataTable rows={rows} countries={benchmarkOrder} unit={amountsUnit} loading={loading} />
      </PageGridTile>

      <PageGridTile id="country-data">
        <h2>{t("wealthPercentile.tables.countryData")}</h2>
        <CountryDataTable
          rows={rows}
          countries={benchmarkOrder}
          unit={amountsUnit}
          loading={loading}
        />
      </PageGridTile>

      <MarkerLegend rows={rows} />

      <PageGridTile id="settings">
        <h2>{t("wealthPercentile.settings.title")}</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1.5rem" }}>
          {BENCHMARK_COUNTRIES.map((c) => (
            <label
              key={c}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={enabledBenchmarks.includes(c)}
                onChange={() => toggleBenchmark(c)}
              />
              <span>{`${t(`wealthPercentile.countries.${c}`)} (${c})`}</span>
            </label>
          ))}
        </div>
      </PageGridTile>
    </main>
  );
}
