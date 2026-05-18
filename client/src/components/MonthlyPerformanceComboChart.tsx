import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  DefaultTooltipContent,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import { useMemo } from "react";
import { densifyRecordsByCalendarPeriod } from "../chartDensifyTimeSeries";
import { formatClp, formatUsd } from "../format";
import {
  buildNiceYAxis,
  computeRegularMonthXAxisTicks,
  computeRegularYearXAxisTicks,
  extractSortedAsOfDates,
  formatLineChartXTick,
  rechartsMoneyYAxisWidth,
  RECHARTS_MONEY_CHART_MARGIN,
  type ChartDisplayUnit,
} from "./ValuationLineCharts";

const AXIS_LINE_STROKE = "#64748b";
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

function formatAxisValue(v: number, unit: ChartDisplayUnit) {
  return unit === "usd" ? formatUsd(v) : formatClp(v);
}

function formatTooltipValue(v: number, unit: ChartDisplayUnit) {
  return unit === "usd" ? formatUsd(v) : formatClp(v);
}

function minMaxForKeys(
  points: Record<string, string | number | null>[],
  keys: string[]
): { min: number; max: number } {
  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of points) {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  if (!Number.isFinite(minV)) return { min: 0, max: 0 };
  return { min: minV, max: maxV };
}

function ComboTooltip({
  active,
  payload,
  label,
  displayUnit,
  areaKey,
  areaName,
  areaStroke,
  xAxisGranularity = "month",
}: TooltipProps<number, string> & {
  displayUnit: ChartDisplayUnit;
  areaKey: string;
  areaName: string;
  areaStroke: string;
  xAxisGranularity?: "month" | "year";
}) {
  if (!active || !payload?.length) return null;
  const stripeHit = payload.find(
    (e) => isAreaStripeDataKey(e.dataKey) && typeof e.value === "number" && Number.isFinite(e.value as number)
  );
  const rest = payload.filter((e) => !isAreaStripeDataKey(e.dataKey));
  const mergedPayload =
    stripeHit != null
      ? [
        ...rest,
        {
          ...stripeHit,
          dataKey: areaKey,
          name: areaName,
          color: areaStroke,
        },
      ]
      : rest;
  return (
    <DefaultTooltipContent<number, string>
      payload={mergedPayload}
      label={label}
      formatter={(v) => formatTooltipValue(typeof v === "number" ? v : Number(v), displayUnit)}
      labelFormatter={(d) => formatLineChartXTick(String(d), xAxisGranularity)}
      contentStyle={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 12px",
        boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
      }}
    />
  );
}

function DiamondDot(props: { cx?: number; cy?: number }) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return null;
  const s = 5;
  return (
    <path
      d={`M${cx},${cy - s} L${cx + s},${cy} L${cx},${cy + s} L${cx - s},${cy} Z`}
      fill="#e0f2fe"
      stroke="#0ea5e9"
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
  areaKey: string;
  areaName: string;
  areaFill: string;
  areaStroke: string;
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
    const k = [...barSeries.map((b) => b.dataKey), areaKey, ...resolvedLineSeries.map((l) => l.dataKey)];
    return k;
  }, [barSeries, areaKey, resolvedLineSeries]);

  const yScale = useMemo(() => {
    const { min, max } = minMaxForKeys(densePoints, yKeys);
    return buildNiceYAxis(min, max);
  }, [densePoints, yKeys]);

  const plotPoints = useMemo(
    () =>
      alternateYearAreaStripes ? augmentPointsWithYearStripeAreas(densePoints, areaKey) : densePoints,
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
    () => pairAlternatingYearAreaFills(areaFill),
    [areaFill]
  );

  if (!points.length) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">Sin datos de P/L mensual para este período.</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div className="chart-box line-chart-focus-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={plotPoints} margin={{ ...RECHARTS_MONEY_CHART_MARGIN }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            {yScale.showZeroReference ? (
              <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
            ) : null}
            <XAxis
              dataKey="as_of_date"
              type="category"
              {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(d: string) => formatLineChartXTick(String(d), xAxisGranularity)}
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              width={rechartsMoneyYAxisWidth(displayUnit)}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(v: number) => formatAxisValue(v, displayUnit)}
            />
            <Tooltip
              content={(props) => (
                <ComboTooltip
                  {...(props as TooltipProps<number, string>)}
                  displayUnit={displayUnit}
                  areaKey={areaKey}
                  areaName={areaName}
                  areaStroke={areaStroke}
                  xAxisGranularity={xAxisGranularity}
                />
              )}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
              formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
            />
            {alternateYearAreaStripes ? (
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
            )}
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
                dot={l.showDot ? <DiamondDot /> : false}
                connectNulls
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
