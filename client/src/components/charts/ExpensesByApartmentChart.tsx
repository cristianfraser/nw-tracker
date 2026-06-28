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
import { formatClp } from "../../format";
import { expenseApartmentLabel } from "../../i18n";
import type { ExpenseApartmentSlug, FlowExpenseChartPoint } from "../../types";
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

const APARTMENT_BAR: { dataKey: ExpenseApartmentSlug; color: string }[] = [
  { dataKey: "lastarria", color: "#db2777" },
  { dataKey: "suecia", color: "#be185d" },
];

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

export function ExpensesByApartmentChart({
  title,
  points,
  xAxisGranularity = "month",
  accountFilter,
}: {
  title: string;
  points: FlowExpenseChartPoint[];
  xAxisGranularity?: "month" | "year";
  /** When set, only these apartments contribute to stacked bars (total line still full). */
  accountFilter?: readonly ExpenseApartmentSlug[];
}) {
  const bars = useMemo(() => {
    if (!accountFilter?.length) return APARTMENT_BAR;
    const set = new Set(accountFilter);
    return APARTMENT_BAR.filter((b) => set.has(b.dataKey));
  }, [accountFilter]);

  const densePoints = points;

  const yKeys = useMemo(() => [...bars.map((b) => b.dataKey), "total"], [bars]);

  const yScale = useMemo(() => {
    const { max } = minMaxForKeys(
      densePoints as unknown as Record<string, string | number | null>[],
      yKeys
    );
    return buildNiceYAxis(0, max);
  }, [densePoints, yKeys]);

  const xAxisTicks = useMemo(() => {
    if (!densePoints.length) return undefined;
    const dates = extractSortedAsOfDates(
      densePoints as unknown as Record<string, string | number | null>[]
    );
    return xAxisGranularity === "year"
      ? computeRegularYearXAxisTicks(dates)
      : computeRegularMonthXAxisTicks(dates);
  }, [densePoints, xAxisGranularity]);

  if (!points.length) {
    return (
      <div className="chart-grid__col">
        <h2 className="chart-panel-title">{title}</h2>
        <p className="empty muted">Sin gastos en este período.</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <h2 className="chart-panel-title">{title}</h2>
      <div className="chart-box line-chart-focus-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={densePoints} margin={{ ...RECHARTS_MONEY_CHART_MARGIN }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
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
              width={rechartsMoneyYAxisWidth("clp")}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(v: number) => formatClp(v)}
            />
            <Tooltip
              content={(props) => (
                <DefaultTooltipContent
                  {...(props as TooltipProps<number, string>)}
                  formatter={(v) => formatClp(typeof v === "number" ? v : Number(v))}
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
            {bars.map((b) => (
              <Bar
                key={b.dataKey}
                dataKey={b.dataKey}
                name={expenseApartmentLabel(b.dataKey)}
                fill={b.color}
                stackId="expenses"
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
                maxBarSize={22}
              />
            ))}
            <Line
              type="monotone"
              dataKey="total"
              name="Total"
              stroke="#e2e8f0"
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
