import { Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo } from "react";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { useTranslation } from "../../i18n";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_TICK_STYLE,
  extractSortedAsOfDates,
  rechartsMoneyYAxisWidth,
  resolvePeriodXAxis,
} from "./chartLayout";

const CHART_ANIM_MS = 90;

const EXPENSES_COLOR = "#ef4444";
const DEPOSITS_COLOR = "#3b82f6";
const PL_COLOR = "#60a5fa";
const INCOME_COLOR = "#22c55e";

/** `expenses` is pre-negated and stacks below the axis; `deposits` and `pl` stack above. */
export type FlowsOverviewChartPoint = {
  as_of_date: string;
  income: number;
  expenses: number;
  deposits: number;
  pl: number;
};

export function FlowsOverviewChart({
  title,
  points,
  xAxisGranularity = "month",
  displayUnit = "clp",
}: {
  title: string;
  points: readonly FlowsOverviewChartPoint[];
  xAxisGranularity?: "month" | "year" | "day";
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();

  // stackOffset="sign": positive segments stack above zero, negatives below.
  const yScale = useMemo(() => {
    let minV = 0;
    let maxV = 0;
    for (const row of points) {
      minV = Math.min(
        minV,
        row.expenses + Math.min(row.deposits, 0) + Math.min(row.pl, 0),
        row.income
      );
      maxV = Math.max(maxV, Math.max(row.deposits, 0) + Math.max(row.pl, 0), row.income);
    }
    return buildNiceYAxis(minV, maxV);
  }, [points]);

  const xAxis = useMemo(
    () =>
      resolvePeriodXAxis(
        extractSortedAsOfDates(points as unknown as Record<string, string | number | null>[]),
        xAxisGranularity
      ),
    [points, xAxisGranularity]
  );

  if (!points.length) {
    return (
      <div className="chart-grid__col">
        <h2 className="chart-panel-title">{title}</h2>
        <p className="empty muted">{t("flows.overview.chartEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <h2 className="chart-panel-title">{title}</h2>
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={[...points]}
          stackOffset="sign"
          tooltip={{
            formatValue: (v) => formatFlowMoney(v, displayUnit),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
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
              {...(xAxis.ticks ? { ticks: xAxis.ticks } : {})}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(d: string) => xAxis.formatTick(String(d))}
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
            <Bar
              dataKey="expenses"
              name={t("flows.overview.expenses")}
              fill={EXPENSES_COLOR}
              stackId="flows"
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
              maxBarSize={22}
            />
            <Bar
              dataKey="deposits"
              name={t("flows.overview.deposits")}
              fill={DEPOSITS_COLOR}
              stackId="flows"
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
              maxBarSize={22}
            />
            <Bar
              dataKey="pl"
              name={t("flows.overview.pl")}
              fill={PL_COLOR}
              stackId="flows"
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
              maxBarSize={22}
            />
            <Line
              type="monotone"
              dataKey="income"
              name={t("flows.overview.income")}
              stroke={INCOME_COLOR}
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
