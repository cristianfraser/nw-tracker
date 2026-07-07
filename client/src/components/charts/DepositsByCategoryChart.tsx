import { Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo } from "react";
import { allocationBucketColor } from "../../chartColors";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { depositFlowCategoryLabel, useTranslation } from "../../i18n";
import type { DepositFlowCategory, FlowDepositChartPoint } from "../../types";
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

const DEPOSIT_CHART_CATEGORIES = ["real_estate", "cash", "brokerage", "inversiones"] as const;

function allocationKeyForDepositChart(cat: DepositFlowCategory): "real_estate" | "cash_eqs" | "brokerage" | "retirement" {
  if (cat === "cash") return "cash_eqs";
  if (cat === "inversiones") return "retirement";
  return cat;
}

const CATEGORY_BAR: { dataKey: DepositFlowCategory; name: string; color: string }[] =
  DEPOSIT_CHART_CATEGORIES.map((dataKey) => ({
    dataKey,
    name: depositFlowCategoryLabel(dataKey),
    color: allocationBucketColor(allocationKeyForDepositChart(dataKey)),
  }));

export function DepositsByCategoryChart({
  title,
  points,
  xAxisGranularity = "month",
  displayUnit = "clp",
}: {
  title: string;
  points: FlowDepositChartPoint[];
  xAxisGranularity?: "month" | "year";
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();
  const densePoints = points;

  const yKeys = useMemo(
    () => [...CATEGORY_BAR.map((b) => b.dataKey), "total"],
    []
  );

  const yScale = useMemo(() => {
    const { min, max } = minMaxForKeys(
      densePoints as unknown as Record<string, string | number | null>[],
      yKeys
    );
    return buildNiceYAxis(Math.min(0, min), max);
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
        <p className="empty muted">{t("deposits.chartEmpty")}</p>
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
            {CATEGORY_BAR.map((b) => (
              <Bar
                key={b.dataKey}
                dataKey={b.dataKey}
                name={b.name}
                fill={b.color}
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
                maxBarSize={22}
              />
            ))}
            <Line
              type="monotone"
              dataKey="total"
              name={t("deposits.chartTotal")}
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
