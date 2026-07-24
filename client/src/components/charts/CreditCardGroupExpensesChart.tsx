import { Bar, CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useCallback, useMemo, useState } from "react";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { chileTodayYmd } from "../../calendarMonth";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import type { CcExpenseCategoryDto, FlowCcExpenseCategoryChartPoint } from "../../types";
import { chartCcExpenseCategories } from "../../ccExpenseCategories";
import {
  EXPENSE_CHART_TOTAL_KEY,
  expenseCategoryChartPointTotal,
} from "../../expenseDepositLinks";
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

type ExpenseChartStyle = "stacked_bar" | "line";

export function CreditCardGroupExpensesChart({
  title,
  points,
  categorySortPoints,
  categories,
  displayUnit = "clp",
  xAxisGranularity = "month",
}: {
  title: string;
  points: readonly FlowCcExpenseCategoryChartPoint[];
  /** When set, category stack order is derived from these (unfiltered) points. */
  categorySortPoints?: readonly FlowCcExpenseCategoryChartPoint[];
  categories: readonly CcExpenseCategoryDto[];
  displayUnit?: DisplayUnit;
  xAxisGranularity?: "month" | "year" | "day";
}) {
  const { t } = useTranslation();
  const bars = useMemo(
    () => chartCcExpenseCategories(categories, categorySortPoints ?? points),
    [categories, categorySortPoints, points]
  );
  const [chartStyle, setChartStyle] = useState<ExpenseChartStyle>("stacked_bar");
  const [hiddenSlugs, setHiddenSlugs] = useState<Set<string>>(() => new Set());

  const toggleSeries = useCallback((slug: string) => {
    setHiddenSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const barKeys = useMemo(() => bars.map((b) => b.slug), [bars]);

  const displayPoints = useMemo(() => {
    if (hiddenSlugs.size === 0) return points;
    return points.map((row) => {
      const next = { ...row };
      for (const slug of hiddenSlugs) next[slug] = 0;
      return next;
    });
  }, [points, hiddenSlugs]);

  const densePoints = useMemo(() => {
    const filled = densifyRecordsByCalendarPeriod(
      displayPoints as unknown as Record<string, string | number | null>[],
      {
        granularity: xAxisGranularity,
        dateKey: "as_of_date",
        fillMissing: { zeroKeys: barKeys },
        extendThroughYmd: chileTodayYmd(),
      }
    ) as unknown as FlowCcExpenseCategoryChartPoint[];
    return filled.map(
      (row): FlowCcExpenseCategoryChartPoint => ({
        ...row,
        [EXPENSE_CHART_TOTAL_KEY]: expenseCategoryChartPointTotal(row, barKeys),
      })
    );
  }, [displayPoints, barKeys, xAxisGranularity]);

  const dates = useMemo(() => extractSortedAsOfDates(densePoints), [densePoints]);
  const xAxis = useMemo(() => resolvePeriodXAxis(dates, xAxisGranularity), [dates, xAxisGranularity]);
  const xTicks = xAxis.ticks;

  const yScale = useMemo(() => {
    let minV = 0;
    let maxV = 0;
    for (const row of densePoints) {
      const total = row[EXPENSE_CHART_TOTAL_KEY];
      if (typeof total === "number" && Number.isFinite(total)) {
        maxV = Math.max(maxV, total);
      }
      if (chartStyle === "line") {
        for (const k of barKeys) {
          const v = row[k];
          if (typeof v === "number" && Number.isFinite(v)) {
            if (v > 0) maxV = Math.max(maxV, v);
            if (v < 0) minV = Math.min(minV, v);
          }
        }
      } else {
        let posStack = 0;
        let negStack = 0;
        for (const k of barKeys) {
          const v = row[k];
          if (typeof v !== "number" || !Number.isFinite(v)) continue;
          if (v > 0) posStack += v;
          else if (v < 0) negStack += v;
        }
        maxV = Math.max(maxV, posStack);
        minV = Math.min(minV, negStack);
      }
    }
    return buildNiceYAxis(minV, maxV);
  }, [densePoints, barKeys, chartStyle]);

  if (points.length === 0) {
    return (
      <section className="chart-panel">
        <h3 className="chart-panel-title">{title}</h3>
        <p className="empty muted">{t("expenses.creditCard.chartEmpty")}</p>
      </section>
    );
  }

  return (
    <section className="chart-panel">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem 1rem",
          marginBottom: "0.5rem",
        }}
      >
        <h3 className="chart-panel-title" style={{ margin: 0 }}>
          {title}
        </h3>
        <div className="chart-controls">
          <span className="label-inline">{t("expenses.creditCard.chartStyleLabel")}</span>
          <label className="radio-pill">
            <input
              type="radio"
              name="cc-expense-chart-style"
              checked={chartStyle === "stacked_bar"}
              onChange={() => setChartStyle("stacked_bar")}
            />
            {t("expenses.creditCard.chartStyleStacked")}
          </label>
          <label className="radio-pill">
            <input
              type="radio"
              name="cc-expense-chart-style"
              checked={chartStyle === "line"}
              onChange={() => setChartStyle("line")}
            />
            {t("expenses.creditCard.chartStyleLine")}
          </label>
        </div>
      </div>
      <div className="chart-box line-chart-focus-wrap" style={{ height: 280 }}>
        <AppComposedChart
          data={densePoints}
          stackOffset={chartStyle === "stacked_bar" ? "sign" : undefined}
          tooltip={{
            formatValue: (v) => formatFlowMoney(v, displayUnit),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
            formatName: (entry) => {
              const slug = String(entry.name ?? entry.dataKey ?? "");
              return slug === EXPENSE_CHART_TOTAL_KEY
                ? t("expenses.creditCard.chartTotal")
                : ccExpenseCategoryLabel(slug);
            },
            mapPayload: (payload) =>
              payload.filter((item) => {
                const slug = String(item.dataKey ?? "");
                if (slug === EXPENSE_CHART_TOTAL_KEY) return true;
                if (hiddenSlugs.has(slug)) return false;
                const v = item.value;
                return typeof v === "number" && Number.isFinite(v) && v !== 0;
              }),
            cursor: true,
          }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis
              dataKey="as_of_date"
              type="category"
              ticks={xTicks}
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
            <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
            <Legend
              wrapperStyle={{
                fontSize: 12,
                color: "var(--muted, #94a3b8)",
                paddingTop: 8,
                cursor: "pointer",
              }}
              onClick={(entry) => {
                const key = entry?.dataKey;
                if (typeof key === "string" && key !== EXPENSE_CHART_TOTAL_KEY) toggleSeries(key);
              }}
              formatter={(value, entry) => {
                const slug = String(entry?.dataKey ?? value);
                if (slug === EXPENSE_CHART_TOTAL_KEY) {
                  return (
                    <span style={{ color: "var(--muted, #94a3b8)" }}>
                      {t("expenses.creditCard.chartTotal")}
                    </span>
                  );
                }
                const hidden = hiddenSlugs.has(slug);
                return (
                  <span
                    style={{
                      color: "var(--muted, #94a3b8)",
                      opacity: hidden ? 0.35 : 1,
                      textDecoration: hidden ? "line-through" : "none",
                      cursor: "pointer",
                    }}
                  >
                    {ccExpenseCategoryLabel(slug)}
                  </span>
                );
              }}
            />
            {chartStyle === "stacked_bar"
              ? bars.map((b) => (
                  <Bar
                    key={b.slug}
                    dataKey={b.slug}
                    name={b.slug}
                    fill={b.chart_color}
                    stackId="gastos"
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                    maxBarSize={22}
                  />
                ))
              : bars.map((b) => (
                  <Line
                    key={b.slug}
                    type="monotone"
                    dataKey={b.slug}
                    name={b.slug}
                    stroke={b.chart_color}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                  />
                ))}
            <Line
              type="monotone"
              dataKey={EXPENSE_CHART_TOTAL_KEY}
              name={EXPENSE_CHART_TOTAL_KEY}
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
