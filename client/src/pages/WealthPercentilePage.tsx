import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Legend, Line, XAxis, YAxis } from "recharts";
import { AppLineChart } from "../components/charts/AppLineChart";
import { minMaxForKeys } from "../components/charts/chartLayout";
import { percentileLogAxisFor, topPercentOf } from "../components/charts/percentileLogAxis";
import { Table } from "../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatCurrency, formatGroupedDecimal } from "../format";
import { useWealthPercentile } from "../queries/hooks";
import type {
  WealthBenchmarkCountry,
  WealthPercentileCell,
  WealthPercentileYearRow,
} from "../types";

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

function thresholdOf(cell: WealthPercentileCell, key: ThresholdKey, unit: "clp" | "usd"): number {
  if (unit === "usd") {
    return key === "p50" ? cell.p50_usd : key === "p90" ? cell.p90_usd : cell.p99_usd;
  }
  return key === "p50" ? cell.p50_clp : key === "p90" ? cell.p90_clp : cell.p99_clp;
}

function rowsDescOf(rows: readonly WealthPercentileYearRow[]): WealthPercentileYearRow[] {
  return [...rows].sort((a, b) => b.year - a.year);
}

/** Año | Patr. financiero | %CL fin. | Patrimonio | %CL | benchmark columns (today's percentile, desc). */
function MyDataTable({
  rows,
  countries,
}: {
  rows: readonly WealthPercentileYearRow[];
  countries: readonly WealthBenchmarkCountry[];
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const money = (usd: number, clp: number) =>
    displayUnit === "usd" ? formatCurrency(usd, "usd") : formatCurrency(clp, "clp");
  const pctText = (cell: WealthPercentileCell) =>
    cell.below_support
      ? t("wealthPercentile.belowSupport")
      : formatGroupedDecimal(cell.percentile ?? Number.NaN, 1);

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("wealthPercentile.table.year")}</th>
        <th className="desktop-only">{t("wealthPercentile.table.finNetWorth")}</th>
        <th className="desktop-only">%CL fin.</th>
        <th className="desktop-only">{t("wealthPercentile.table.netWorth")}</th>
        <th className="desktop-only">%CL</th>
        {countries.map((c) => (
          <th key={c} className="desktop-only">{`%${c}`}</th>
        ))}
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <Table header={header} tableClassName="table--parallel-mobile">
      {rowsDescOf(rows).map((row) => {
        const yearLabel = `${row.year}${yearMarkers(row)}`;
        return (
          <tr key={row.year}>
            <td className="mono desktop-only">{yearLabel}</td>
            <td className="mono desktop-only">{money(row.fin_net_worth_usd, row.fin_net_worth_clp)}</td>
            <td className="mono desktop-only">{pctText(row.cl_financial)}</td>
            <td className="mono desktop-only">{money(row.net_worth_usd, row.net_worth_clp)}</td>
            <td className="mono desktop-only">{pctText(row.cl_total)}</td>
            {countries.map((c) => (
              <td key={c} className="mono desktop-only">
                {pctText(row.benchmarks[c])}
              </td>
            ))}
            <td className="mobile-only">
              <TableMobileCard title={yearLabel}>
                <TableMobileCardRow
                  label={t("wealthPercentile.table.finNetWorth")}
                  value={money(row.fin_net_worth_usd, row.fin_net_worth_clp)}
                />
                <TableMobileCardRow label="%CL fin." value={pctText(row.cl_financial)} />
                <TableMobileCardRow
                  label={t("wealthPercentile.table.netWorth")}
                  value={money(row.net_worth_usd, row.net_worth_clp)}
                />
                <TableMobileCardRow label="%CL" value={pctText(row.cl_total)} />
                {countries.map((c) => (
                  <TableMobileCardRow key={c} label={`%${c}`} value={pctText(row.benchmarks[c])} />
                ))}
              </TableMobileCard>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

/** p50/p90/p99 stacked for one distribution cell; a pair dims once its threshold sits below today's net worth. */
function ThresholdPairsCell({
  cell,
  currentNwUsd,
  displayUnit,
}: {
  cell: WealthPercentileCell;
  currentNwUsd: number;
  displayUnit: "clp" | "usd";
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
      {THRESHOLD_KEYS_DESC.map((k) => {
        // Compare in USD so dimming is independent of the CLP/USD display toggle.
        const surpassed = thresholdOf(cell, k, "usd") < currentNwUsd;
        return (
          <span key={k} style={{ whiteSpace: "nowrap", ...(surpassed ? { opacity: 0.28 } : null) }}>
            {`${k}: ${formatCurrency(thresholdOf(cell, k, displayUnit), displayUnit)}`}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Año | CL fin. | CL | benchmark columns (same order as MyDataTable) — p99/p90/p50 per cell; surpassed
 * thresholds dim. The CL fin. column (Chile financial-wealth distribution, ex real estate) dims against
 * today's FINANCIAL net worth; total-mode columns dim against today's total net worth.
 */
function CountryDataTable({
  rows,
  currentNwUsd,
  currentFinNwUsd,
  countries,
}: {
  rows: readonly WealthPercentileYearRow[];
  currentNwUsd: number;
  currentFinNwUsd: number;
  countries: readonly WealthBenchmarkCountry[];
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const pairs = (cell: WealthPercentileCell, baselineUsd: number) => (
    <ThresholdPairsCell cell={cell} currentNwUsd={baselineUsd} displayUnit={displayUnit} />
  );

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("wealthPercentile.table.year")}</th>
        <th className="desktop-only">CL fin.</th>
        <th className="desktop-only">CL</th>
        {countries.map((c) => (
          <th key={c} className="desktop-only">
            {c}
          </th>
        ))}
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <Table header={header} tableClassName="table--parallel-mobile">
      {rowsDescOf(rows).map((row) => {
        const yearLabel = `${row.year}${yearMarkers(row)}`;
        return (
          <tr key={row.year}>
            <td className="mono desktop-only" style={{ verticalAlign: "top" }}>
              {yearLabel}
            </td>
            <td className="mono desktop-only">{pairs(row.cl_financial, currentFinNwUsd)}</td>
            <td className="mono desktop-only">{pairs(row.cl_total, currentNwUsd)}</td>
            {countries.map((c) => (
              <td key={c} className="mono desktop-only">
                {pairs(row.benchmarks[c], currentNwUsd)}
              </td>
            ))}
            <td className="mobile-only">
              <TableMobileCard title={yearLabel}>
                <TableMobileCardRow label="CL fin." value={pairs(row.cl_financial, currentFinNwUsd)} />
                <TableMobileCardRow label="CL" value={pairs(row.cl_total, currentNwUsd)} />
                {countries.map((c) => (
                  <TableMobileCardRow key={c} label={c} value={pairs(row.benchmarks[c], currentNwUsd)} />
                ))}
              </TableMobileCard>
            </td>
          </tr>
        );
      })}
    </Table>
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
  const { data, error, isPending } = useWealthPercentile();

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

  if (isPending && !data) return <p className="muted">{t("common.loading")}</p>;
  if (error) {
    return (
      <main>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }
  if (!data) return null;

  // Dimming baseline + column order both come from the latest row (current year, valued as of today).
  const latestRow = data.rows.length ? data.rows.reduce((m, r) => (r.year > m.year ? r : m)) : null;
  const currentNwUsd = latestRow?.net_worth_usd ?? 0;
  const currentFinNwUsd = latestRow?.fin_net_worth_usd ?? 0;
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
      <p className="muted">{t("wealthPercentile.intro")}</p>

      <label
        style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}
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

      <div style={{ width: "100%", height: 320 }}>
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
          <Legend />
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
      </div>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("wealthPercentile.tables.myData")}</h2>
        <MyDataTable rows={data.rows} countries={benchmarkOrder} />
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("wealthPercentile.tables.countryData")}</h2>
        <CountryDataTable
          rows={data.rows}
          currentNwUsd={currentNwUsd}
          currentFinNwUsd={currentFinNwUsd}
          countries={benchmarkOrder}
        />
      </section>

      <MarkerLegend rows={data.rows} />

      <section style={{ margin: "1.5rem 0" }}>
        <h3>{t("wealthPercentile.caveats.title")}</h3>
        <ul className="muted" style={{ fontSize: "0.85em" }}>
          <li>{t("wealthPercentile.caveats.tail")}</li>
          <li>{t("wealthPercentile.caveats.reconstruction")}</li>
          <li>{t("wealthPercentile.caveats.benchmarkReconstruction")}</li>
          <li>{t("wealthPercentile.caveats.methodologyBreak")}</li>
          <li>{t("wealthPercentile.caveats.adults")}</li>
          <li>{t("wealthPercentile.caveats.fx")}</li>
        </ul>
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h3>{t("wealthPercentile.settings.title")}</h3>
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
      </section>
    </main>
  );
}
