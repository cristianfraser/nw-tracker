import { useMemo } from "react";
import { densifyRecordsByCalendarDay, type ChartSparseRow } from "../../chartDensifyTimeSeries";
import { cn } from "../../cn";
import { currencyFormatInfo, formatPctCompactParts } from "../../format";
import { useTranslation } from "../../i18n";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { clipRowsToTimeRange } from "../../timeRange";
import type { RatesRecentEntry } from "../../types";
import { ChartEmptyState } from "../charts/ChartEmptyState";
import { ChartPanelTitleRow } from "../charts/ChartPanelTitleRow";
import { buildNiceYAxisPositiveBand } from "../charts/chartLayout";
import { RatesLineChart, type RatesLineSeries } from "../charts/RatesLineChart";
import { loadableClass } from "../ui/Loadable";
import { SurfaceControls } from "../ui/SurfaceControls";
import styles from "./Rates.module.css";

export type RatesChartLine = RatesLineSeries & {
  /** The line's stored observations, in ascending date order. */
  points: readonly { date: string; value: number }[];
};

type ChartRow = Record<string, string | number | null>;

/** Every line's observations on one row per date. */
function mergeLines(lines: readonly RatesChartLine[]): ChartRow[] {
  const byDate = new Map<string, ChartRow>();
  for (const line of lines) {
    for (const p of line.points) {
      if (!Number.isFinite(p.value)) continue;
      let row = byDate.get(p.date);
      if (!row) {
        row = { date: p.date };
        for (const l of lines) row[l.dataKey] = null;
        byDate.set(p.date, row);
      }
      row[line.dataKey] = p.value;
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** A change against the previous entry, signed and coloured by its direction. */
function ChangeCell({ pct }: { pct: number | null }) {
  if (pct == null || !Number.isFinite(pct)) return <span className={cn("mono", styles.flat)}>—</span>;
  const { text, sign } = formatPctCompactParts(pct);
  return <span className={cn("mono", sign > 0 ? styles.up : sign < 0 ? styles.down : styles.flat)}>{text}</span>;
}

/**
 * A series' latest stored entries (the server's `recent`, newest first): date, value and the
 * change against the entry before; USD/CLP adds the observado and the day's buy / sell rate on a
 * line under the entry. One rendering at every width.
 */
function RatesRecentList({
  entries,
  formatValue,
  loading,
}: {
  entries: readonly RatesRecentEntry[];
  formatValue: (n: number) => string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  if (entries.length === 0 && !loading) return null;
  return (
    <div className={styles.recent}>
      <div className={cn(styles.recentRow, styles.recentHead)} aria-hidden="true">
        <span>{t("rates.recentColDate")}</span>
        <span>{t("rates.recentColValue")}</span>
        <span>{t("rates.recent.colChange")}</span>
      </div>
      <ul className={styles.recentList} aria-label={t("rates.recent.title")}>
        {entries.map((e) => {
          const extras = [
            e.observado != null ? t("rates.recent.observado", { value: formatValue(e.observado) }) : null,
            e.buy != null && e.sell != null
              ? t("rates.recent.buySell", { buy: formatValue(e.buy), sell: formatValue(e.sell) })
              : null,
          ].filter((x): x is string => x != null);
          return (
            <li key={e.date} className={styles.recentRow}>
              <span className="mono">{e.date}</span>
              <span className="mono">
                <span className="visually-hidden">{t("rates.recentColValue")} </span>
                {formatValue(e.value)}
              </span>
              <span>
                <span className="visually-hidden">{t("rates.recent.colChange")} </span>
                <ChangeCell pct={e.change_pct} />
              </span>
              {extras.length > 0 ? <span className={cn("mono", styles.recentExtra)}>{extras.join(" · ")}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One chart of the rates page: the position page's chart tile — title row with its own Rango,
 * the plot — then the series' latest entries. `valueCurrency` sizes the Y axis (`none` for an
 * index).
 */
export function RatesChartTile({
  surfaceId,
  title,
  note,
  lines,
  showLegend,
  valueCurrency,
  formatValue,
  recent,
  loading,
}: {
  /** The tile's stored Rango (`rates.<series id>`). */
  surfaceId: string;
  title: string;
  /** What one unit of the series is («CLP per US$1»). */
  note?: string;
  lines: readonly RatesChartLine[];
  /** Name the lines under the title (a tile with several). */
  showLegend?: boolean;
  valueCurrency: string;
  formatValue: (n: number) => string;
  recent: readonly RatesRecentEntry[];
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const prefs = useSurfacePrefs(surfaceId, "month", "1y");
  const merged = useMemo(() => mergeLines(lines), [lines]);
  const chartData = useMemo(() => {
    const clipped = clipRowsToTimeRange(merged, prefs.range, (r) => String(r.date));
    return densifyRecordsByCalendarDay(
      clipped as ChartSparseRow[],
      "date",
      lines.map((l) => l.dataKey)
    );
  }, [merged, prefs.range, lines]);

  const yBand = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of chartData) {
      for (const l of lines) {
        const v = row[l.dataKey];
        if (typeof v === "number" && Number.isFinite(v)) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? buildNiceYAxisPositiveBand(min, max) : null;
  }, [chartData, lines]);

  // Whole-unit currencies (pesos) carry more digits on the axis than ones with cents.
  const axisWidth = valueCurrency === "none" ? 62 : currencyFormatInfo(valueCurrency).minorDigits === 0 ? 104 : 78;
  const drawn = lines.filter((l) => l.points.length > 0);

  return (
    <section className={loadableClass(loading, "chart-grid__col", styles.tile)} data-rates-series={surfaceId}>
      <ChartPanelTitleRow
        title={title}
        titleAs="h3"
        controls={<SurfaceControls range={prefs.range} onRangeChange={prefs.setRange} />}
      />
      {note ? <p className={cn("muted", styles.note)}>{note}</p> : null}
      {showLegend && drawn.length > 1 ? (
        <p className={cn("muted", styles.note, styles.legend)}>
          {drawn.map((l) => (
            <span key={l.dataKey} className={styles.legendItem}>
              <i
                className={cn(styles.legendSwatch, l.strokeDasharray && styles.legendSwatchDashed)}
                style={{ borderTopColor: l.stroke }}
                aria-hidden="true"
              />
              {l.name ?? l.dataKey}
            </span>
          ))}
        </p>
      ) : null}
      {chartData.length === 0 ? (
        <ChartEmptyState loading={loading} message={t("rates.noData")} boxStyle={{ height: "var(--rates-plot-height)" }} />
      ) : (
        <div className={cn("rates-plot", styles.plot)}>
          <RatesLineChart data={chartData} yAxisWidth={axisWidth} yBand={yBand} formatValue={formatValue} series={drawn} />
        </div>
      )}
      <RatesRecentList entries={recent} formatValue={formatValue} loading={loading} />
    </section>
  );
}
