import {
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
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { useTranslation } from "../../i18n";
import {
  buildNiceYAxis,
  computeRegularMonthXAxisTicks,
  computeRegularYearXAxisTicks,
  extractSortedAsOfDates,
  formatLineChartXTick,
  rechartsMoneyYAxisWidth,
  RECHARTS_MONEY_CHART_MARGIN,
} from "./ValuationLineCharts";

const AXIS_LINE_STROKE = "#64748b";
const CHART_ANIM_MS = 90;

const EXPENSES_COLOR = "#ef4444";
const DEPOSITS_COLOR = "#3b82f6";
const INCOME_COLOR = "#22c55e";

/** `expenses` stacks above the axis; `deposits` is pre-negated and stacks below. */
export type FlowsOverviewChartPoint = {
  as_of_date: string;
  income: number;
  expenses: number;
  deposits: number;
};

export function FlowsOverviewChart({
  title,
  points,
  xAxisGranularity = "month",
  displayUnit = "clp",
}: {
  title: string;
  points: readonly FlowsOverviewChartPoint[];
  xAxisGranularity?: "month" | "year";
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();

  // stackOffset="sign": positive segments stack above zero, negatives below.
  const yScale = useMemo(() => {
    let minV = 0;
    let maxV = 0;
    for (const row of points) {
      minV = Math.min(minV, Math.min(row.deposits, 0), row.income);
      maxV = Math.max(maxV, row.expenses + Math.max(row.deposits, 0), row.income);
    }
    return buildNiceYAxis(minV, maxV);
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
        <p className="empty muted">{t("flows.overview.chartEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <h2 className="chart-panel-title">{title}</h2>
      <div className="chart-box line-chart-focus-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={[...points]}
            stackOffset="sign"
            margin={{ ...RECHARTS_MONEY_CHART_MARGIN }}
          >
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
              tickFormatter={(v: number) => formatFlowMoney(v, displayUnit)}
            />
            <Tooltip
              content={(props) => (
                <DefaultTooltipContent
                  {...(props as TooltipProps<number, string>)}
                  formatter={(v) =>
                    formatFlowMoney(typeof v === "number" ? v : Number(v), displayUnit)
                  }
                  labelFormatter={(d) => formatLineChartXTick(String(d), xAxisGranularity)}
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "10px 12px",
                    boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                  }}
                />
              )}
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
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
