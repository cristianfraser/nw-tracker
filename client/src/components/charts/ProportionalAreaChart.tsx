import { Area, Legend, XAxis, YAxis } from "recharts";
import { useMemo, type ReactNode } from "react";
import i18n from "../../i18n";
import { formatPct } from "../../format";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { timeRangeCutoffYmd, type TimeRange } from "../../timeRange";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  CHART_ANIM_MS,
  CHART_TICK_STYLE,
  resolvePeriodXAxis,
  extractSortedAsOfDates,
} from "./chartLayout";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import type { ProportionalSeriesBlockDto, ProportionalSeriesLineDto } from "../../types";

const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Proportional composition chart — the timeseries replacement for the allocation pies:
 * 100%-stacked areas of the server-built share series (values 0..1, Σ==1 per date; see
 * `server/src/proportionalSeries.ts` for the negative-floor convention). Stacked areas at
 * every grain per the product decision. Yearly renders the last available date per year.
 */
export function ProportionalAreaChart({
  title,
  titleAs = "h2",
  controls,
  block,
  xAxisGranularity,
  timeRange,
  colorFor,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  controls?: ReactNode;
  block: ProportionalSeriesBlockDto | null | undefined;
  xAxisGranularity: "day" | "month" | "year";
  /** Per-surface Rango for the M/Y clip (daily payloads arrive server-windowed). */
  timeRange?: TimeRange;
  /** Series color, from the caller's existing maps (bucket palette / group color maps). */
  colorFor: (line: ProportionalSeriesLineDto, index: number) => string;
}) {
  const series = block?.series ?? [];

  const rows = useMemo(() => {
    if (!block) return [];
    let out: Record<string, string | number | null>[] = block.dates.map((d, i) => {
      const row: Record<string, string | number | null> = { as_of_date: d };
      for (const s of block.series) row[s.dataKey] = s.values[i] ?? null;
      return row;
    });
    // Drop dates with no base at all (every share null) — usually the leading empty months.
    out = out.filter((row) => block.series.some((s) => typeof row[s.dataKey] === "number"));
    // Rango clip for M/Y (daily payloads arrive server-windowed to `days`); yearly samples
    // AFTER the clip so a short range shows the partial-year composition, like the combos.
    if (xAxisGranularity !== "day" && timeRange) {
      const cutoff = timeRangeCutoffYmd(timeRange);
      if (cutoff != null) out = out.filter((row) => String(row.as_of_date) >= cutoff);
    }
    if (xAxisGranularity === "year") {
      const lastOfYear = new Map<string, Record<string, string | number | null>>();
      for (const row of out) lastOfYear.set(String(row.as_of_date).slice(0, 4), row);
      out = [...lastOfYear.values()];
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

  if (!rows.length || !series.length) {
    return (
      <div className="chart-grid__col">
        <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
        <p className="empty muted">{i18n.t("charts.noValuationSeries")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={rows}
          tooltip={{
            formatValue: (v) => (typeof v === "number" ? formatPct(v * 100) : "—"),
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
            domain={[0, 1]}
            ticks={Y_TICKS}
            width={48}
            tick={CHART_TICK_STYLE}
            axisLine={{ stroke: AXIS_LINE_STROKE }}
            tickLine={{ stroke: AXIS_LINE_STROKE }}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          {series.map((s, idx) => {
            const color = colorFor(s, idx);
            return (
              <Area
                key={s.dataKey}
                type="monotone"
                stackId="shares"
                dataKey={s.dataKey}
                name={s.name_i18n_key ? i18n.t(s.name_i18n_key) : s.name}
                stroke={color}
                fill={color}
                fillOpacity={0.55}
                strokeWidth={1}
                connectNulls
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
              />
            );
          })}
        </AppComposedChart>
      </div>
    </div>
  );
}
