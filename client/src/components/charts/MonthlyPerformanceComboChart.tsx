import { Area, Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo } from "react";
import { lightenStrokeForAccumulated } from "../../chartColors";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import i18n from "../../i18n";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_TICK_STYLE,
  computeRegularMonthXAxisTicks,
  computeRegularYearXAxisTicks,
  extractSortedAsOfDates,
  formatAxisValue,
  formatLineChartXTick,
  formatTooltipValue,
  minMaxForKeys,
  rechartsMoneyYAxisWidth,
  type ChartDisplayUnit,
} from "./chartLayout";

const CHART_ANIM_MS = 90;

/** Split YTD / cumulative area by calendar year parity for alternating fills. */
const AREA_STRIPE_EVEN = "__areaStripe_even";
const AREA_STRIPE_ODD = "__areaStripe_odd";

function isAreaStripeDataKey(k: unknown): boolean {
  const s = String(k ?? "");
  return s === AREA_STRIPE_EVEN || s === AREA_STRIPE_ODD;
}

/** Two rgba fills from the primary `areaFill` so consecutive years read distinctly. */
function pairAlternatingYearAreaFills(baseFill: string): [string, string] {
  const m = baseFill.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/i);
  if (!m) {
    return [baseFill, "rgba(94, 108, 128, 0.36)"];
  }
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const a = Number(m[4]);
  if (![r, g, b, a].every((x) => Number.isFinite(x))) {
    return [baseFill, "rgba(94, 108, 128, 0.36)"];
  }
  const r2 = Math.min(255, Math.round(r * 0.72 + 36));
  const g2 = Math.min(255, Math.round(g * 0.72 + 40));
  const b2 = Math.min(255, Math.round(b * 0.72 + 46));
  const a2 = Math.min(0.48, a + 0.1);
  return [baseFill, `rgba(${r2},${g2},${b2},${a2})`];
}

function augmentPointsWithYearStripeAreas(
  rows: Record<string, string | number | null>[],
  areaKey: string
): Record<string, string | number | null>[] {
  return rows.map((row) => {
    const v = row[areaKey];
    const num = typeof v === "number" && Number.isFinite(v) ? v : null;
    const d = String(row.as_of_date ?? "");
    const y = Number(d.slice(0, 4));
    const yearOk = Number.isFinite(y);
    const evenYear = yearOk && y % 2 === 0;
    return {
      ...row,
      [AREA_STRIPE_EVEN]: evenYear && num != null ? num : null,
      [AREA_STRIPE_ODD]: !evenYear && num != null ? num : null,
    };
  });
}

export type MonthlyPlBarSeries = { dataKey: string; name: string; color: string };

export type MonthlyPlLineSeries = {
  dataKey: string;
  name: string;
  stroke: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  showDot?: boolean;
};

function diamondDotFill(stroke: string): string {
  const lightened = lightenStrokeForAccumulated(stroke);
  if (lightened !== stroke) return lightened;
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(stroke);
  if (rgb) {
    return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},0.28)`;
  }
  return "rgba(148, 163, 184, 0.35)";
}

function DiamondDot(props: { cx?: number; cy?: number; stroke?: string }) {
  const { cx, cy, stroke = "#0ea5e9" } = props;
  if (cx == null || cy == null) return null;
  const s = 5;
  return (
    <path
      d={`M${cx},${cy - s} L${cx + s},${cy} L${cx},${cy + s} L${cx - s},${cy} Z`}
      fill={diamondDotFill(stroke)}
      stroke={stroke}
      strokeWidth={1.5}
    />
  );
}

export function MonthlyPerformanceComboChart({
  title,
  titleAs = "h2",
  points,
  displayUnit,
  barSeries,
  areaKey,
  areaName,
  areaFill,
  areaStroke,
  lineKey,
  lineName,
  lineSeries,
  /** When true (default), YTD-style area is split into two fills by calendar year parity. Set false for a single continuous area fill (e.g. accumulated earnings). */
  alternateYearAreaStripes = true,
  xAxisGranularity = "month",
}: {
  title: string;
  titleAs?: "h2" | "h3";
  points: Record<string, string | number | null>[];
  displayUnit: ChartDisplayUnit;
  barSeries: MonthlyPlBarSeries[];
  areaKey?: string;
  areaName?: string;
  areaFill?: string;
  areaStroke?: string;
  lineKey?: string;
  lineName?: string;
  lineSeries?: MonthlyPlLineSeries[];
  alternateYearAreaStripes?: boolean;
  xAxisGranularity?: "month" | "year";
}) {
  const TitleTag = titleAs;

  const densePoints = useMemo(() => {
    const zeroKeys = barSeries.map((b) => b.dataKey);
    return densifyRecordsByCalendarPeriod(points, {
      granularity: xAxisGranularity,
      dateKey: "as_of_date",
      fillMissing: { zeroKeys },
    });
  }, [points, xAxisGranularity, barSeries]);

  const resolvedLineSeries = useMemo((): MonthlyPlLineSeries[] => {
    if (lineSeries?.length) return lineSeries;
    if (lineKey && lineName) {
      return [{ dataKey: lineKey, name: lineName, stroke: "#38bdf8", showDot: true }];
    }
    return [];
  }, [lineSeries, lineKey, lineName]);

  const yKeys = useMemo(() => {
    const k = [...barSeries.map((b) => b.dataKey), ...resolvedLineSeries.map((l) => l.dataKey)];
    if (areaKey) k.push(areaKey);
    return k;
  }, [barSeries, areaKey, resolvedLineSeries]);

  const yScale = useMemo(() => {
    const { min, max } = minMaxForKeys(densePoints, yKeys);
    return buildNiceYAxis(min, max);
  }, [densePoints, yKeys]);

  const plotPoints = useMemo(
    () =>
      areaKey && alternateYearAreaStripes
        ? augmentPointsWithYearStripeAreas(densePoints, areaKey)
        : densePoints,
    [densePoints, areaKey, alternateYearAreaStripes]
  );

  const xAxisTicks = useMemo(() => {
    if (!densePoints.length) return undefined;
    const dates = extractSortedAsOfDates(densePoints);
    return xAxisGranularity === "year"
      ? computeRegularYearXAxisTicks(dates)
      : computeRegularMonthXAxisTicks(dates);
  }, [densePoints, xAxisGranularity]);

  const [fillEvenYear, fillOddYear] = useMemo(
    () => pairAlternatingYearAreaFills(areaFill ?? "rgba(148, 163, 184, 0.22)"),
    [areaFill]
  );

  if (!points.length) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">{i18n.t("charts.noMonthlyPl")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={plotPoints}
          tooltip={{
            formatValue: (v) => formatTooltipValue(v, displayUnit),
            formatLabel: (d) => formatLineChartXTick(String(d), xAxisGranularity),
            // The YTD area renders as two year-parity stripe series; merge whichever stripe is
            // hit back into a single row labeled as the area.
            mapPayload: (payload) => {
              const stripeHit = payload.find(
                (e) =>
                  isAreaStripeDataKey(e.dataKey) &&
                  typeof e.value === "number" &&
                  Number.isFinite(e.value)
              );
              const rest = payload.filter((e) => !isAreaStripeDataKey(e.dataKey));
              return stripeHit != null
                ? [
                    ...rest,
                    {
                      ...stripeHit,
                      dataKey: areaKey ?? "",
                      name: areaName ?? "",
                      color: areaStroke ?? "#64748b",
                    },
                  ]
                : rest;
            },
            cursor: true,
          }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            {yScale.showZeroReference ? (
              <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
            ) : null}
            <XAxis
              dataKey="as_of_date"
              type="category"
              {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(d: string) => formatLineChartXTick(String(d), xAxisGranularity)}
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              width={rechartsMoneyYAxisWidth(displayUnit)}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(v: number) => formatAxisValue(v, displayUnit)}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
              formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
            />
            {areaKey && areaFill && areaStroke && areaName ? (
              alternateYearAreaStripes ? (
                <>
                  <Area
                    type="monotone"
                    dataKey={AREA_STRIPE_EVEN}
                    name=""
                    stroke={areaStroke}
                    fill={fillEvenYear}
                    fillOpacity={1}
                    strokeWidth={1.2}
                    connectNulls={false}
                    legendType="none"
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                  />
                  <Area
                    type="monotone"
                    dataKey={AREA_STRIPE_ODD}
                    name={areaName}
                    stroke={areaStroke}
                    fill={fillOddYear}
                    fillOpacity={1}
                    strokeWidth={1.2}
                    connectNulls={false}
                    legendType="rect"
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                  />
                </>
              ) : (
                <Area
                  type="monotone"
                  dataKey={areaKey}
                  name={areaName}
                  stroke={areaStroke}
                  fill={areaFill}
                  fillOpacity={1}
                  strokeWidth={1.2}
                  connectNulls
                  legendType="rect"
                  isAnimationActive
                  animationDuration={CHART_ANIM_MS}
                />
              )
            ) : null}
            {barSeries.map((b) => (
              <Bar
                key={b.dataKey}
                dataKey={b.dataKey}
                name={b.name}
                fill={b.color}
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
                maxBarSize={28}
              />
            ))}
            {resolvedLineSeries.map((l) => (
              <Line
                key={l.dataKey}
                type="monotone"
                dataKey={l.dataKey}
                name={l.name}
                stroke={l.stroke}
                strokeWidth={l.strokeWidth ?? 1.5}
                strokeDasharray={l.strokeDasharray ?? "4 3"}
                dot={
                  l.showDot
                    ? ({ key, cx, cy }) => (
                        <DiamondDot key={key} cx={cx} cy={cy} stroke={l.stroke} />
                      )
                    : false
                }
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
