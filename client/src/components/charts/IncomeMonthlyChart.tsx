import { Bar, CartesianGrid, Legend, Line, XAxis, YAxis } from "recharts";
import { useMemo } from "react";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { chileTodayYmd } from "../../calendarMonth";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { useTranslation } from "../../i18n";
import type { FlowIncomeChartPoint } from "../../types";
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

const SERIES = [
  { dataKey: "salary" as const, color: "#22c55e" },
  { dataKey: "severance" as const, color: "#f59e0b" },
  { dataKey: "parent_gift" as const, color: "#a78bfa" },
  { dataKey: "other" as const, color: "#64748b" },
];

export function IncomeMonthlyChart({
  title,
  points,
  xAxisGranularity = "month",
  displayUnit = "clp",
}: {
  title: string;
  points: readonly FlowIncomeChartPoint[];
  xAxisGranularity?: "month" | "year" | "day";
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();

  const densePoints = useMemo(() => {
    const zeroKeys = ["salary", "severance", "parent_gift", "other", "total"];
    return densifyRecordsByCalendarPeriod(
      points as unknown as Record<string, string | number | null>[],
      {
        granularity: xAxisGranularity,
        dateKey: "as_of_date",
        fillMissing: { zeroKeys },
        extendThroughYmd: chileTodayYmd(),
      }
    ) as unknown as FlowIncomeChartPoint[];
  }, [points, xAxisGranularity]);

  const yScale = useMemo(() => {
    let maxV = 0;
    for (const row of densePoints) {
      maxV = Math.max(maxV, row.total);
    }
    return buildNiceYAxis(0, maxV);
  }, [densePoints]);

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
      <section className="chart-panel">
        <h3 className="chart-panel-title">{title}</h3>
        <p className="empty muted">{t("income.chartEmpty")}</p>
      </section>
    );
  }

  return (
    <section className="chart-panel">
      <h3 className="chart-panel-title">{title}</h3>
      <div className="chart-box line-chart-focus-wrap" style={{ height: 280 }}>
        <AppComposedChart
          data={densePoints}
          tooltip={{
            formatValue: (v) => formatFlowMoney(v, displayUnit),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
            formatName: (entry) => {
              const key = String(entry.name ?? entry.dataKey ?? "");
              const labels: Record<string, string> = {
                salary: t("income.chart.salary"),
                severance: t("income.chart.severance"),
                parent_gift: t("income.chart.parent_gift"),
                other: t("income.chart.other"),
                total: t("income.colTotal"),
              };
              return labels[key] ?? key;
            },
            cursor: true,
          }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
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
              formatter={(value) => {
                const labels: Record<string, string> = {
                  salary: t("income.chart.salary"),
                  severance: t("income.chart.severance"),
                  parent_gift: t("income.chart.parent_gift"),
                  other: t("income.chart.other"),
                  total: t("income.colTotal"),
                };
                return (
                  <span style={{ color: "var(--muted, #94a3b8)" }}>
                    {labels[value] ?? value}
                  </span>
                );
              }}
            />
            {SERIES.map((s) => (
              <Bar
                key={s.dataKey}
                dataKey={s.dataKey}
                name={s.dataKey}
                fill={s.color}
                stackId="income"
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
                maxBarSize={22}
              />
            ))}
            <Line
              type="monotone"
              dataKey="total"
              name="total"
              stroke="#e2e8f0"
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
        </AppComposedChart>
      </div>
    </section>
  );
}
