import { Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo } from "react";
import { allocationBucketColor } from "../../chartColors";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { flowsPlBucketLabel, useTranslation } from "../../i18n";
import type { FlowsPlBucketSlug, FlowsPlChartPoint } from "../../types";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_TICK_STYLE,
  computeRegularMonthXAxisTicks,
  computeRegularYearXAxisTicks,
  extractSortedAsOfDates,
  formatLineChartXTick,
  minMaxForKeys,
  rechartsMoneyYAxisWidth,
} from "./chartLayout";

const CHART_ANIM_MS = 90;

const PL_CHART_BUCKETS: { dataKey: FlowsPlBucketSlug; color: string }[] = [
  { dataKey: "brokerage", color: allocationBucketColor("brokerage") },
  { dataKey: "retirement", color: allocationBucketColor("retirement") },
  { dataKey: "cash", color: allocationBucketColor("cash_eqs") },
];

export function FlowsPlChart({
  title,
  points,
  xAxisGranularity = "month",
  displayUnit = "clp",
}: {
  title: string;
  points: readonly FlowsPlChartPoint[];
  xAxisGranularity?: "month" | "year";
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();

  const yScale = useMemo(() => {
    const { min, max } = minMaxForKeys(
      points as unknown as Record<string, string | number | null>[],
      [...PL_CHART_BUCKETS.map((b) => b.dataKey), "total"]
    );
    return buildNiceYAxis(Math.min(0, min), Math.max(0, max));
  }, [points]);

  const xAxisTicks = useMemo(() => {
    if (!points.length) return undefined;
    const dates = extractSortedAsOfDates(
      points as unknown as Record<string, string | number | null>[]
    );
    return xAxisGranularity === "year"
      ? computeRegularYearXAxisTicks(dates)
      : computeRegularMonthXAxisTicks(dates);
  }, [points, xAxisGranularity]);

  if (!points.length) {
    return (
      <div className="chart-grid__col">
        <h2 className="chart-panel-title">{title}</h2>
        <p className="empty muted">{t("flows.pl.chartEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <h2 className="chart-panel-title">{title}</h2>
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={[...points]}
          tooltip={{
            formatValue: (v) => formatFlowMoney(v, displayUnit),
            formatLabel: (d) => formatLineChartXTick(String(d), xAxisGranularity),
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
              tickFormatter={(v: number) => formatFlowMoney(v, displayUnit)}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
              formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
            />
            {PL_CHART_BUCKETS.map((b) => (
              <Bar
                key={b.dataKey}
                dataKey={b.dataKey}
                name={flowsPlBucketLabel(b.dataKey)}
                fill={b.color}
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
                maxBarSize={22}
              />
            ))}
            <Line
              type="monotone"
              dataKey="total"
              name={t("flows.pl.colTotal")}
              stroke="#e2e8f0"
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
        </AppComposedChart>
      </div>
    </div>
  );
}
