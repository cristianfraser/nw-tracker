import { Bar, Legend, Line, XAxis, YAxis } from "recharts";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { AppComposedChart } from "./AppComposedChart";
import { AXIS_LINE_STROKE, CHART_TICK_STYLE, moneyYAxisProps, type resolvePeriodXAxis } from "./chartLayout";

const CHART_ANIM_MS = 90;

/** «Bruto vs líquido»: the payroll stack as bars under the gross line (the income page). */
export function PayrollBreakdownChart({
  points,
  displayUnit,
  xAxis,
  yScale,
  compactAxis,
  stack,
  label,
}: {
  points: Record<string, number | string | null>[];
  displayUnit: DisplayUnit;
  xAxis: ReturnType<typeof resolvePeriodXAxis>;
  yScale: { domain: [number, number]; ticks: number[] };
  compactAxis: boolean;
  stack: readonly { key: string; color: string }[];
  /** A series key's label, translated by the page at render. */
  label: (key: string) => string;
}) {
  return (
    <AppComposedChart
      data={points}
      // The shown payload's unit: a held payload turning into the new unit's tweens like data arriving.
      animationKey={displayUnit}
      tooltip={{
        formatValue: (v) => formatFlowMoney(v, displayUnit),
        formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
        formatName: (entry) => label(String(entry.name ?? entry.dataKey ?? "")),
        cursor: true,
      }}
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
      <Legend
        itemSorter={null}
        wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
        formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{label(String(value))}</span>}
      />
      {stack.map((s) => (
        <Bar
          key={s.key}
          dataKey={s.key}
          name={s.key}
          fill={s.color}
          stackId="payroll"
          isAnimationActive
          animationDuration={CHART_ANIM_MS}
          maxBarSize={22}
        />
      ))}
      <Line
        type="monotone"
        dataKey="gross"
        name="gross"
        stroke="#e2e8f0"
        strokeWidth={2}
        dot={false}
        isAnimationActive
        animationDuration={CHART_ANIM_MS}
      />
    </AppComposedChart>
  );
}
