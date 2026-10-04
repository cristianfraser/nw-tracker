import { Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo, type ReactNode } from "react";
import i18n from "../../i18n";
import { chartStrokeFromRgbTriplet } from "../../chartColors";
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
import type { ProportionalSeriesBlockDto } from "../../types";

/**
 * Mortgage coverage (Pasivos): each server-built series is a reference line ÷ the mortgage
 * balance (`server/src/referenceCoverage.ts`), drawn as percent lines with a dashed 100% line —
 * where that money would clear the mortgage. Same block shape and grain handling as the
 * proportional chart it replaces there: Rango clips M/Y, yearly samples each year's last row.
 */
export function CoverageLineChart({
  title,
  controls,
  block,
  xAxisGranularity,
  timeRange,
}: {
  title: string;
  controls?: ReactNode;
  block: ProportionalSeriesBlockDto | null | undefined;
  xAxisGranularity: "day" | "month" | "year";
  timeRange?: TimeRange;
}) {
  const series = block?.series ?? [];

  const rows = useMemo(() => {
    if (!block) return [];
    let out: Record<string, string | number | null>[] = block.dates.map((d, i) => {
      const row: Record<string, string | number | null> = { as_of_date: d };
      for (const s of block.series) {
        const v = s.values[i];
        row[s.dataKey] = v == null ? null : v * 100;
      }
      return row;
    });
    // Coverage starts with the mortgage: drop the dates before it (every series null).
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
    return buildNiceYAxis(lo, hi);
  }, [rows, series]);

  if (!rows.length || !series.length) {
    return (
      <div className="chart-grid__col">
        <ChartPanelTitleRow title={title} controls={controls} />
        <p className="empty muted">{i18n.t("charts.noValuationSeries")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <ChartPanelTitleRow title={title} controls={controls} />
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={rows}
          tooltip={{
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
          {series.map((s, i) => (
            <Line
              key={s.dataKey}
              type="monotone"
              dataKey={s.dataKey}
              name={s.name_i18n_key ? i18n.t(s.name_i18n_key) : s.name}
              stroke={chartStrokeFromRgbTriplet(s.color_rgb)}
              strokeWidth={i === 0 ? 2 : 1.5}
              dot={false}
              connectNulls
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
          ))}
        </AppComposedChart>
      </div>
    </div>
  );
}
