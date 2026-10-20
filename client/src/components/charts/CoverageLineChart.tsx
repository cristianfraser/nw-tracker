import { Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo, type ReactNode } from "react";
import i18n from "../../i18n";
import { chartStrokeFromRgbTriplet, parseRgbTriplet } from "../../chartColors";
import { formatPct } from "../../format";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { clipMonthsThenRollup, type TimeRange } from "../../timeRange";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  CHART_ANIM_MS,
  CHART_TICK_STYLE,
  buildNiceYAxis,
  extractSortedAsOfDates,
  resolvePeriodXAxis,
} from "./chartLayout";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { ChartEmptyState } from "./ChartEmptyState";
import { loadableClass } from "../ui/Loadable";
import type { ProportionalSeriesBlockDto } from "../../types";

/**
 * Liabilities coverage (Pasivos): each server-built series is a reference line ÷ the total owed
 * (`server/src/referenceCoverage.ts`), drawn as percent lines with a dashed 100% line — where
 * that money would clear every debt. Same block shape and grain handling as the
 * proportional chart it replaces there: Rango clips M/Y, yearly samples each year's last row.
 *
 * The axis stops at `COVERAGE_AXIS_CAP_PCT`: while the only debt is a small card balance the
 * coverage runs into the thousands of percent, and a 0-anchored axis holding that flattens the
 * era that matters (20–110% against the mortgage). Each line is DRAWN clamped to the cap, so it
 * runs along the top edge instead of leaving the plot, and the run where it is clamped is
 * overlaid in a darker shade of its colour so the clamp is visible. The rows keep the true
 * values under the series' own keys, and the tooltip reads those.
 */
export const COVERAGE_AXIS_CAP_PCT = 200;
const drawnKey = (dataKey: string) => `${dataKey}|drawn`;
const cappedKey = (dataKey: string) => `${dataKey}|capped`;
/** The series colour mixed toward black, for the clamped run. */
function cappedStroke(colorRgb: string | null | undefined, baseStroke: string, mixTowardBlack = 0.45): string {
  const triplet = parseRgbTriplet(colorRgb) ?? parseHexTriplet(baseStroke);
  if (!triplet) return baseStroke;
  const k = 1 - mixTowardBlack;
  return `rgb(${triplet.map((c) => Math.round(c * k)).join(",")})`;
}
function parseHexTriplet(stroke: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(stroke.trim());
  if (!m) return null;
  const h = m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function CoverageLineChart({
  title,
  controls,
  block,
  xAxisGranularity,
  timeRange,
  loading,
}: {
  title: string;
  controls?: ReactNode;
  /** Null/undefined + `loading` = the pending frame; null/undefined + not loading = the «no data» copy. */
  block: ProportionalSeriesBlockDto | null | undefined;
  xAxisGranularity: "day" | "month" | "year";
  timeRange?: TimeRange;
  /** The block is not in yet (or is held prior data): dim the panel, no «no data» copy. */
  loading?: boolean;
}) {
  const series = block?.series ?? [];

  const rows = useMemo(() => {
    if (!block) return [];
    let out: Record<string, string | number | null>[] = block.dates.map((d, i) => {
      const row: Record<string, string | number | null> = { as_of_date: d };
      for (const s of block.series) {
        const v = s.values[i];
        const pct = v == null ? null : v * 100;
        row[s.dataKey] = pct;
        row[drawnKey(s.dataKey)] = pct == null ? null : Math.min(pct, COVERAGE_AXIS_CAP_PCT);
        row[cappedKey(s.dataKey)] = pct != null && pct > COVERAGE_AXIS_CAP_PCT ? COVERAGE_AXIS_CAP_PCT : null;
      }
      return row;
    });
    // Coverage starts with the first debt: drop the dates before it (every series null).
    const first = out.findIndex((row) => block.series.some((s) => typeof row[s.dataKey] === "number"));
    out = first < 0 ? [] : out.slice(first);
    if (xAxisGranularity !== "day") {
      out = clipMonthsThenRollup(out, xAxisGranularity, timeRange ?? "total", (months) => {
        const lastOfYear = new Map<string, Record<string, string | number | null>>();
        for (const row of months) lastOfYear.set(String(row.as_of_date).slice(0, 4), row);
        return [...lastOfYear.values()];
      });
    }
    return densifyRecordsByCalendarPeriod(out, {
      granularity: xAxisGranularity,
      dateKey: "as_of_date",
      fillMissing: "null_all",
    });
  }, [block, xAxisGranularity, timeRange]);

  const xAxis = useMemo(
    () => resolvePeriodXAxis(extractSortedAsOfDates(rows), xAxisGranularity),
    [rows, xAxisGranularity]
  );

  const yAxis = useMemo(() => {
    let lo = 0;
    let hi = 100;
    for (const row of rows) {
      for (const s of series) {
        const v = row[s.dataKey];
        if (typeof v !== "number") continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    return buildNiceYAxis(lo, Math.min(hi, COVERAGE_AXIS_CAP_PCT));
  }, [rows, series]);

  if (!rows.length || !series.length) {
    return (
      <div className={loadableClass(loading, "chart-grid__col")}>
        <ChartPanelTitleRow title={title} controls={controls} />
        <ChartEmptyState loading={loading} message={i18n.t("charts.noValuationSeries")} />
      </div>
    );
  }

  return (
    <div className={loadableClass(loading, "chart-grid__col")}>
      <ChartPanelTitleRow title={title} controls={controls} />
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={rows}
          tooltip={{
            // One row per series, carrying the TRUE value (the drawn one is clamped).
            mapPayload: (payload) =>
              payload.flatMap((e) => {
                const s = series.find((x) => drawnKey(x.dataKey) === e.dataKey);
                if (!s) return [];
                const row = e.payload as Record<string, unknown> | undefined;
                const real = row?.[s.dataKey];
                return [{ ...e, value: typeof real === "number" ? real : undefined }];
              }),
            formatValue: (v) => (typeof v === "number" ? formatPct(v, 1) : "—"),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
            cursor: true,
          }}
          grid={{ stroke: "rgba(148, 163, 184, 0.15)", opacity: 1 }}
        >
          <XAxis
            dataKey="as_of_date"
            type="category"
            {...(xAxis.ticks ? { ticks: xAxis.ticks } : {})}
            tick={CHART_TICK_STYLE}
            axisLine={{ stroke: AXIS_LINE_STROKE }}
            tickLine={{ stroke: AXIS_LINE_STROKE }}
            tickFormatter={(d: string) => xAxis.formatTick(String(d))}
          />
          <YAxis
            domain={yAxis.domain}
            ticks={yAxis.ticks}
            width={48}
            tick={CHART_TICK_STYLE}
            axisLine={{ stroke: AXIS_LINE_STROKE }}
            tickLine={{ stroke: AXIS_LINE_STROKE }}
            tickFormatter={(v: number) => `${Math.round(v)}%`}
          />
          <ReferenceLine y={100} stroke="var(--muted, #94a3b8)" strokeDasharray="4 4" strokeWidth={1} />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          {series.map((s, i) => {
            const stroke = chartStrokeFromRgbTriplet(s.color_rgb);
            const width = i === 0 ? 2 : 1.5;
            return (
              <Line
                key={s.dataKey}
                type="monotone"
                dataKey={drawnKey(s.dataKey)}
                name={s.name_i18n_key ? i18n.t(s.name_i18n_key) : s.name}
                stroke={stroke}
                strokeWidth={width}
                dot={false}
                connectNulls
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
              />
            );
          })}
          {series.map((s, i) => (
            // The clamped run, drawn over the line in a darker shade; segments only (no connectNulls).
            <Line
              key={cappedKey(s.dataKey)}
              type="linear"
              dataKey={cappedKey(s.dataKey)}
              stroke={cappedStroke(s.color_rgb, chartStrokeFromRgbTriplet(s.color_rgb))}
              strokeWidth={(i === 0 ? 2 : 1.5) + 0.5}
              dot={false}
              legendType="none"
              tooltipType="none"
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
          ))}
        </AppComposedChart>
      </div>
    </div>
  );
}
