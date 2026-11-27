import { Area, Line, ReferenceDot, XAxis, YAxis } from "recharts";
import { useMemo, type ReactNode } from "react";
import i18n from "../../i18n";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { clipPointsToTimeRange, type TimeRange } from "../../timeRange";
import { dataKeysWithWindowData } from "../../chartSeriesWindowPresence";
import { GROUP_TAB_VAL_TOTAL } from "../../groupTabAggregation";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import type { TimeseriesAccountLine, TimeseriesBlock } from "../../types";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_ANIM_MS,
  CHART_TICK_STYLE,
  extractSortedAsOfDates,
  formatTooltipValue,
  moneyYAxisProps,
  RECHARTS_MONEY_CHART_MARGIN,
  resolvePeriodXAxis,
  type ChartDisplayUnit,
} from "./chartLayout";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { ChartEmptyState } from "./ChartEmptyState";
import { loadableClass } from "../ui/Loadable";

type Row = Record<string, string | number | null>;

/** The aportes line's stroke (the valuation chart's deposit lines are muted too). */
const DEPOSITS_STROKE = "#94a3b8";

/** Room at the right of the plot for the end labels (a band's name, «aportes»). */
const END_LABEL_MARGIN = 64;

/** A band thinner than this share of the last row's total gets no end label (they would collide). */
const MIN_LABELLED_SHARE = 0.04;

/** The end labels' line height (px): closer labels are pushed apart. */
const END_LABEL_LINE = 11;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function lineName(line: TimeseriesAccountLine): string {
  return line.name_i18n_key ? i18n.t(line.name_i18n_key, line.name_i18n_params) : line.name;
}

/**
 * «Valor por posición»: the group's value stacked by its children (the server's grouped
 * valuation block — one line per child, the same membership as the P/L bars and the children
 * table), the heaviest today at the bottom, with the group's aportes line over the stack. No
 * legend: each band is named at its right end, and its colour is the child's dot in the table.
 * The block is the caller's (monthly, year-end rolled, or the daily lines mapped onto it); the
 * M/Y views clip to `timeRange` here, the daily payload arrives windowed.
 */
export function StackedValueAreaChart({
  title,
  titleAs = "h2",
  controls,
  block,
  displayUnit,
  xAxisGranularity,
  timeRange,
  colorFor,
  hideDeposits = false,
  loading,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  controls?: ReactNode;
  /** Null + `loading` = the pending frame; null + not loading = the «no data» copy. */
  block: TimeseriesBlock | null;
  displayUnit: ChartDisplayUnit;
  xAxisGranularity: "day" | "month" | "year";
  timeRange?: TimeRange;
  /** A child line's colour (the page's group colour maps, so band, bar and dot match). */
  colorFor: (line: TimeseriesAccountLine) => string;
  /** No aportes line (a cash group: its contributions are its balance). */
  hideDeposits?: boolean;
  loading?: boolean;
}) {
  const compactAxis = useIsNarrowViewport();

  const childLines = useMemo(
    () => (block?.accounts ?? []).filter((a) => a.dataKey !== GROUP_TAB_VAL_TOTAL && !a.exclude_from_group_totals),
    [block]
  );
  const depositsKey = useMemo(
    () =>
      hideDeposits
        ? null
        : ((block?.accounts ?? []).find((a) => a.dataKey === GROUP_TAB_VAL_TOTAL)?.depositDataKey ?? null),
    [block, hideDeposits]
  );

  const rows = useMemo((): Row[] => {
    if (!block) return [];
    let out = xAxisGranularity === "day" ? block.points : clipPointsToTimeRange(block.points, timeRange ?? "total");
    // Leading rows where no child holds anything yet draw nothing.
    const first = out.findIndex((r) => childLines.some((l) => (num(r[l.dataKey]) ?? 0) !== 0));
    out = first < 0 ? [] : out.slice(first);
    if (block.chart_end_ymd) {
      const end = block.chart_end_ymd;
      out = out.filter((r) => String(r.as_of_date ?? "").localeCompare(end) <= 0);
    }
    return densifyRecordsByCalendarPeriod(out, {
      granularity: xAxisGranularity,
      dateKey: "as_of_date",
      fillMissing: "null_all",
    });
  }, [block, childLines, xAxisGranularity, timeRange]);

  // Children with a band in the window, heaviest on the last row first (the bottom of the stack).
  const stacked = useMemo(() => {
    const present = dataKeysWithWindowData(
      rows,
      childLines.map((l) => l.dataKey),
      { treatZeroAsEmpty: true }
    );
    const last = rows[rows.length - 1];
    return childLines
      .filter((l) => present.has(l.dataKey))
      .map((line) => ({ line, color: colorFor(line), lastValue: num(last?.[line.dataKey]) ?? 0 }))
      .sort((a, b) => b.lastValue - a.lastValue);
  }, [rows, childLines, colorFor]);

  const yScale = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      let sum = 0;
      for (const { line } of stacked) sum += Math.max(0, num(r[line.dataKey]) ?? 0);
      max = Math.max(max, sum, depositsKey ? (num(r[depositsKey]) ?? 0) : 0);
    }
    return buildNiceYAxis(0, max);
  }, [rows, stacked, depositsKey]);

  const xAxis = useMemo(
    () => resolvePeriodXAxis(extractSortedAsOfDates(rows), xAxisGranularity),
    [rows, xAxisGranularity]
  );

  if (!rows.length || !stacked.length) {
    return (
      <div className={loadableClass(loading, "chart-grid__col")}>
        <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
        <ChartEmptyState loading={loading} message={i18n.t("charts.noValuationSeries")} />
      </div>
    );
  }

  const lastIndex = rows.length - 1;
  const lastTotal = stacked.reduce((s, x) => s + Math.max(0, x.lastValue), 0);
  const lastDate = String(rows[lastIndex]?.as_of_date ?? "");
  // A band's name at its right end, just under its top edge; thin bands stay unlabelled, and a
  // label that would overlap one already placed (the bands draw bottom up) moves up a line.
  // Drawn on reference dots, not the Areas' `label`: Recharts hides an Area's labels while it
  // animates, and every live-quote refetch re-animates the bands, so the names would blink.
  const placedLabelYs = new Map<string, number>();
  const endLabels: { key: string; name: string; color: string; top: number }[] = [];
  let bandTop = 0;
  for (const { line, color, lastValue } of stacked) {
    bandTop += Math.max(0, lastValue);
    const share = lastTotal > 0 ? lastValue / lastTotal : 0;
    if (share >= MIN_LABELLED_SHARE) endLabels.push({ key: line.dataKey, name: lineName(line), color, top: bandTop });
  }
  const endLabelContent = (name: string, color: string) =>
    function EndLabel(props: { viewBox?: unknown }) {
      const box = (props.viewBox ?? {}) as { x?: number; y?: number };
      const x = Number(box.x);
      let y = Number(box.y) + 10;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const others = [...placedLabelYs].filter(([k]) => k !== name).map(([, v]) => v);
      while (others.some((p) => Math.abs(p - y) < END_LABEL_LINE)) y -= END_LABEL_LINE;
      placedLabelYs.set(name, y);
      return (
        <text x={x + 6} y={y} fill={color} fontSize={10} className="mono">
          {name}
        </text>
      );
    };

  return (
    <div className={loadableClass(loading, "chart-grid__col")}>
      <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={rows}
          // A held payload turning into the new unit's tweens like data arriving.
          animationKey={displayUnit}
          margin={{ ...RECHARTS_MONEY_CHART_MARGIN, right: END_LABEL_MARGIN }}
          tooltip={{
            formatValue: (v) => formatTooltipValue(v, displayUnit),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
            cursor: true,
          }}
          grid={{ stroke: "rgba(148, 163, 184, 0.15)", opacity: 1, vertical: false }}
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
          <YAxis domain={yScale.domain} ticks={yScale.ticks} {...moneyYAxisProps(displayUnit, compactAxis, yScale.ticks)} />
          {stacked.map(({ line, color }) => (
            <Area
              key={line.dataKey}
              type="linear"
              stackId="positions"
              dataKey={line.dataKey}
              name={lineName(line)}
              stroke={color}
              fill={color}
              fillOpacity={0.45}
              strokeWidth={1}
              connectNulls
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
          ))}
          {endLabels.map(({ key, name, color, top }) => (
            <ReferenceDot
              key={`end-label-${key}`}
              x={lastDate}
              y={top}
              r={0}
              ifOverflow="visible"
              label={{ content: endLabelContent(name, color) }}
            />
          ))}
          {depositsKey ? (
            <Line
              type="stepAfter"
              dataKey={depositsKey}
              name={i18n.t("charts.accumulatedDeposits")}
              stroke={DEPOSITS_STROKE}
              strokeDasharray="3 3"
              strokeWidth={1}
              dot={false}
              connectNulls
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
          ) : null}
        </AppComposedChart>
      </div>
    </div>
  );
}
