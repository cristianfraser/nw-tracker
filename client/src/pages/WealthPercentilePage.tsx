import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CartesianGrid, Legend, Line, XAxis, YAxis } from "recharts";
import { AppLineChart } from "../components/charts/AppLineChart";
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

const BENCHMARK_COUNTRIES: readonly WealthBenchmarkCountry[] = ["US", "ES", "CH", "UK"];

type ThresholdKey = "p50" | "p90" | "p99";
const THRESHOLD_KEYS: readonly ThresholdKey[] = ["p50", "p90", "p99"];

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

/** Año | Patr. financiero | %CL fin. | Patrimonio | %CL | %US | %ES | %CH | %UK. */
function MyDataTable({ rows }: { rows: readonly WealthPercentileYearRow[] }) {
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
        {BENCHMARK_COUNTRIES.map((c) => (
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
            {BENCHMARK_COUNTRIES.map((c) => (
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
                {BENCHMARK_COUNTRIES.map((c) => (
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

/** Año | CL | US | ES | CH | UK — one selected threshold, total-mode distributions. */
function CountryDataTable({
  rows,
  threshold,
}: {
  rows: readonly WealthPercentileYearRow[];
  threshold: ThresholdKey;
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const cellText = (cell: WealthPercentileCell) =>
    formatCurrency(thresholdOf(cell, threshold, displayUnit), displayUnit);

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("wealthPercentile.table.year")}</th>
        <th className="desktop-only">CL</th>
        {BENCHMARK_COUNTRIES.map((c) => (
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
            <td className="mono desktop-only">{yearLabel}</td>
            <td className="mono desktop-only">{cellText(row.cl_total)}</td>
            {BENCHMARK_COUNTRIES.map((c) => (
              <td key={c} className="mono desktop-only">
                {cellText(row.benchmarks[c])}
              </td>
            ))}
            <td className="mobile-only">
              <TableMobileCard title={`${yearLabel} · ${threshold}`}>
                <TableMobileCardRow label="CL" value={cellText(row.cl_total)} />
                {BENCHMARK_COUNTRIES.map((c) => (
                  <TableMobileCardRow key={c} label={c} value={cellText(row.benchmarks[c])} />
                ))}
              </TableMobileCard>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

/** Año | p50 | p90 | p99 — Chile financial-wealth distribution. */
function ClFinancialThresholdsTable({ rows }: { rows: readonly WealthPercentileYearRow[] }) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const cellText = (cell: WealthPercentileCell, key: ThresholdKey) =>
    formatCurrency(thresholdOf(cell, key, displayUnit), displayUnit);

  const header = (
    <thead>
      <tr>
        <th className="desktop-only">{t("wealthPercentile.table.year")}</th>
        {THRESHOLD_KEYS.map((k) => (
          <th key={k} className="desktop-only">
            {k}
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
            <td className="mono desktop-only">{yearLabel}</td>
            {THRESHOLD_KEYS.map((k) => (
              <td key={k} className="mono desktop-only">
                {cellText(row.cl_financial, k)}
              </td>
            ))}
            <td className="mobile-only">
              <TableMobileCard title={yearLabel}>
                {THRESHOLD_KEYS.map((k) => (
                  <TableMobileCardRow key={k} label={k} value={cellText(row.cl_financial, k)} />
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
  const [threshold, setThreshold] = useState<ThresholdKey>("p90");
  const { data, error, isPending } = useWealthPercentile();

  // Raw numbers only — formatting happens at render time (separator/language toggles).
  const chartPoints = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        year: String(r.year),
        total: r.cl_total.percentile,
        financial: r.cl_financial.percentile,
      })),
    [data]
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

  return (
    <main>
      <h1>{t("wealthPercentile.title")}</h1>
      <p className="muted">{t("wealthPercentile.intro")}</p>

      <div style={{ width: "100%", height: 320 }}>
        <AppLineChart
          data={chartPoints}
          tooltip={{
            formatValue: (v) => formatGroupedDecimal(Number(v), 1),
            formatLabel: (l) => String(l),
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="year" tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={20} />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            width={30}
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="total"
            name={t("wealthPercentile.chart.seriesTotal")}
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="financial"
            name={t("wealthPercentile.chart.seriesFinancial")}
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={false}
          />
        </AppLineChart>
      </div>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("wealthPercentile.tables.myData")}</h2>
        <MyDataTable rows={data.rows} />
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("wealthPercentile.tables.countryData")}</h2>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
          <span className="muted" style={{ fontSize: "0.85em" }}>
            {t("wealthPercentile.table.thresholdLabel")}
          </span>
          <select value={threshold} onChange={(e) => setThreshold(e.target.value as ThresholdKey)}>
            {THRESHOLD_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <CountryDataTable rows={data.rows} threshold={threshold} />
      </section>

      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("wealthPercentile.tables.clFinancialThresholds")}</h2>
        <ClFinancialThresholdsTable rows={data.rows} />
      </section>

      <MarkerLegend rows={data.rows} />

      <section style={{ margin: "1.5rem 0" }}>
        <h3>{t("wealthPercentile.caveats.title")}</h3>
        <ul className="muted" style={{ fontSize: "0.85em" }}>
          <li>{t("wealthPercentile.caveats.tail")}</li>
          <li>{t("wealthPercentile.caveats.reconstruction")}</li>
          <li>{t("wealthPercentile.caveats.methodologyBreak")}</li>
          <li>{t("wealthPercentile.caveats.adults")}</li>
          <li>{t("wealthPercentile.caveats.fx")}</li>
        </ul>
      </section>
    </main>
  );
}
