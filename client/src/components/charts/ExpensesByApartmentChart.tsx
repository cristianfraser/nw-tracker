import { Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo } from "react";
import { formatClp } from "../../format";
import i18n from "../../i18n";
import type { ExpenseApartmentSlug, FlowExpenseChartPoint } from "../../types";
import { AppComposedChart } from "./AppComposedChart";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_TICK_STYLE,
  extractSortedAsOfDates,
  minMaxForKeys,
  rechartsMoneyYAxisWidth,
  resolvePeriodXAxis,
} from "./chartLayout";

const CHART_ANIM_MS = 90;

/** Stacked-bar colors assigned to places by their payload order. */
const PLACE_BAR_PALETTE = ["#f472b6", "#db2777", "#be185d", "#9d174d", "#831843", "#fbcfe8"];

export function ExpensesByApartmentChart({
  title,
  points,
  places,
  xAxisGranularity = "month",
  accountFilter,
}: {
  title: string;
  points: FlowExpenseChartPoint[];
  /** Tracked places in display order (from the payload — data, not code). */
  places: readonly { slug: ExpenseApartmentSlug; label: string }[];
  xAxisGranularity?: "month" | "year";
  /** When set, only these places contribute to stacked bars (total line still full). */
  accountFilter?: readonly ExpenseApartmentSlug[];
}) {
  const bars = useMemo(() => {
    const all = places.map((p, i) => ({
      dataKey: p.slug,
      label: p.label,
      color: PLACE_BAR_PALETTE[i % PLACE_BAR_PALETTE.length]!,
    }));
    if (!accountFilter?.length) return all;
    const set = new Set(accountFilter);
    return all.filter((b) => set.has(b.dataKey));
  }, [places, accountFilter]);

  const densePoints = points;

  const yKeys = useMemo(() => [...bars.map((b) => b.dataKey), "total"], [bars]);

  const yScale = useMemo(() => {
    const { max } = minMaxForKeys(
      densePoints as unknown as Record<string, string | number | null>[],
      yKeys
    );
    return buildNiceYAxis(0, max);
  }, [densePoints, yKeys]);

  const xAxis = useMemo(
    () =>
      resolvePeriodXAxis(
        extractSortedAsOfDates(densePoints as unknown as Record<string, string | number | null>[]),
        xAxisGranularity
      ),
    [densePoints, xAxisGranularity]
  );

  if (!points.length) {
    return (
      <div className="chart-grid__col">
        <h2 className="chart-panel-title">{title}</h2>
        <p className="empty muted">{i18n.t("charts.noExpensesInPeriod")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <h2 className="chart-panel-title">{title}</h2>
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={densePoints}
          tooltip={{
            formatValue: (v) => formatClp(v),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
            cursor: true,
          }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
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
              width={rechartsMoneyYAxisWidth("clp")}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(v: number) => formatClp(v)}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
              formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
            />
            {bars.map((b) => (
              <Bar
                key={b.dataKey}
                dataKey={b.dataKey}
                name={b.label}
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
        </AppComposedChart>
      </div>
    </div>
  );
}
