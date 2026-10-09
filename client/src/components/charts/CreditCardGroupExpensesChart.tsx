import type { ReactNode } from "react";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { ChartEmptyState } from "./ChartEmptyState";
import { loadableClass } from "../ui/Loadable";
import { Bar, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useCallback, useMemo, useState } from "react";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { chileTodayYmd } from "../../calendarMonth";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import type {
  CcExpenseCategoryDto,
  ExpenseYearMonthlyAverage,
  FlowCcExpenseCategoryChartPoint,
} from "../../types";
import { chartCcExpenseCategories } from "../../ccExpenseCategories";
import {
  EXPENSE_CHART_TOTAL_KEY,
  expenseCategoryChartPointTotal,
} from "../../expenseDepositLinks";
import { AppComposedChart } from "./AppComposedChart";
import { renderPeriodRefLine } from "./PeriodRefLine";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_TICK_STYLE,
  currentPeriodRefX,
  extractSortedAsOfDates,
  moneyYAxisProps,
  resolvePeriodXAxis,
} from "./chartLayout";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";

const CHART_ANIM_MS = 90;
const TOTAL_LINE_STROKE = "#e2e8f0";
/** Row key carrying the year's average monthly gastos (tooltip only; drawn as segments). */
const YEAR_AVERAGE_KEY = "__year_avg";

type ExpenseChartStyle = "stacked_bar" | "line";

export function CreditCardGroupExpensesChart({
  title,
  controls,
  points,
  categorySortPoints,
  categories,
  displayUnit = "clp",
  xAxisGranularity = "month",
  yearAverages,
  loading,
}: {
  title: string;
  /** Per-surface Período/Rango controls, rendered next to the title. */
  controls?: ReactNode;
  points: readonly FlowCcExpenseCategoryChartPoint[];
  /** When set, category stack order is derived from these (unfiltered) points. */
  categorySortPoints?: readonly FlowCcExpenseCategoryChartPoint[];
  categories: readonly CcExpenseCategoryDto[];
  displayUnit?: DisplayUnit;
  xAxisGranularity?: "month" | "year";
  /**
   * Per-year average monthly gastos, drawn as one flat segment per year over its months on the
   * axis (with a toggle). Null/absent = not offered (yearly chart, short Rango).
   */
  yearAverages?: Readonly<Record<string, ExpenseYearMonthlyAverage>> | null;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const compactAxis = useIsNarrowViewport();
  const bars = useMemo(
    () => chartCcExpenseCategories(categories, categorySortPoints ?? points),
    [categories, categorySortPoints, points]
  );
  const [chartStyle, setChartStyle] = useState<ExpenseChartStyle>("stacked_bar");
  const [hiddenSlugs, setHiddenSlugs] = useState<Set<string>>(() => new Set());
  const [showYearAverages, setShowYearAverages] = useState(true);

  const toggleSeries = useCallback((slug: string) => {
    setHiddenSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const barKeys = useMemo(() => bars.map((b) => b.slug), [bars]);

  /**
   * The total is taken before legend-hidden categories are zeroed: hiding a category changes
   * the stack, never the Total line (or the year averages drawn against it).
   */
  const densePoints = useMemo(() => {
    const displayPoints = points.map((row) => {
      const next: FlowCcExpenseCategoryChartPoint = {
        ...row,
        [EXPENSE_CHART_TOTAL_KEY]: expenseCategoryChartPointTotal(row, barKeys),
      };
      for (const slug of hiddenSlugs) next[slug] = 0;
      return next;
    });
    return densifyRecordsByCalendarPeriod(
      displayPoints as unknown as Record<string, string | number | null>[],
      {
        granularity: xAxisGranularity,
        dateKey: "as_of_date",
        fillMissing: { zeroKeys: [...barKeys, EXPENSE_CHART_TOTAL_KEY] },
        extendThroughYmd: chileTodayYmd(),
      }
    ) as unknown as FlowCcExpenseCategoryChartPoint[];
  }, [points, hiddenSlugs, barKeys, xAxisGranularity]);

  /** One flat segment per year, over that year's plotted months inside its averaged span. */
  const yearAverageSegments = useMemo(() => {
    if (!yearAverages) return [];
    const byYear = new Map<string, { avg: number; first: string; last: string }>();
    for (const row of densePoints) {
      const ym = row.as_of_date.slice(0, 7);
      const year = ym.slice(0, 4);
      const entry = yearAverages[year];
      if (!entry || ym < entry.from_ym || ym > entry.through_ym) continue;
      const seg = byYear.get(year);
      if (seg) seg.last = row.as_of_date;
      else byYear.set(year, { avg: entry.avg, first: row.as_of_date, last: row.as_of_date });
    }
    return [...byYear.entries()].map(([year, seg]) => ({ year, ...seg }));
  }, [densePoints, yearAverages]);

  /** Chart rows: the dense points plus each month's year average while the line is shown. */
  const chartRows = useMemo(() => {
    if (!yearAverages || !showYearAverages) return densePoints;
    return densePoints.map((row) => {
      const ym = row.as_of_date.slice(0, 7);
      const entry = yearAverages[ym.slice(0, 4)];
      if (!entry || ym < entry.from_ym || ym > entry.through_ym) return row;
      return { ...row, [YEAR_AVERAGE_KEY]: entry.avg };
    });
  }, [densePoints, showYearAverages, yearAverages]);

  const dates = useMemo(() => extractSortedAsOfDates(densePoints), [densePoints]);
  const xAxis = useMemo(() => resolvePeriodXAxis(dates, xAxisGranularity), [dates, xAxisGranularity]);
  const xTicks = xAxis.ticks;
  // Current-period marker (bare dotted line); null when the current bucket is the last one, so it
  // only shows when future buckets (e.g. Por-cuota months) extend the axis past it.
  const currentPeriodX = useMemo(
    () => currentPeriodRefX(dates, xAxisGranularity, chileTodayYmd()),
    [dates, xAxisGranularity]
  );

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
    // Fine 1M-CLP (1k-USD) ticks in the 0–4M band where monthly spend clusters; the
    // range-derived coarse steps stay sparse elsewhere (and on yearly-scale axes entirely).
    return buildNiceYAxis(minV, maxV, { fineUnit: displayUnit === "usd" ? 1_000 : 1_000_000 });
  }, [densePoints, barKeys, chartStyle, displayUnit]);

  if (points.length === 0) {
    return (
      <section className="chart-panel">
        <ChartPanelTitleRow title={title} titleAs="h3" controls={controls} />
        <ChartEmptyState loading={loading} message={t("expenses.creditCard.chartEmpty")} boxStyle={{ height: 280 }} />
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
        {controls}
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
          {yearAverages ? (
            <label className="radio-pill">
              <input
                type="checkbox"
                checked={showYearAverages}
                onChange={(e) => setShowYearAverages(e.target.checked)}
              />
              {t("expenses.creditCard.chartYearAverage")}
            </label>
          ) : null}
        </div>
      </div>
      <div className={loadableClass(loading, "chart-box line-chart-focus-wrap")} style={{ height: 280 }}>
        <AppComposedChart
          data={chartRows}
          stackOffset={chartStyle === "stacked_bar" ? "sign" : undefined}
          tooltip={{
            formatValue: (v) => formatFlowMoney(v, displayUnit),
            formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
            formatName: (entry) => {
              const slug = String(entry.name ?? entry.dataKey ?? "");
              if (slug === EXPENSE_CHART_TOTAL_KEY) return t("expenses.creditCard.chartTotal");
              if (slug === YEAR_AVERAGE_KEY) return t("expenses.creditCard.chartYearAverage");
              return ccExpenseCategoryLabel(slug);
            },
            mapPayload: (payload) =>
              payload.filter((item) => {
                const slug = String(item.dataKey ?? "");
                if (slug === EXPENSE_CHART_TOTAL_KEY) return true;
                if (slug === YEAR_AVERAGE_KEY) {
                  return typeof item.value === "number" && Number.isFinite(item.value);
                }
                if (hiddenSlugs.has(slug)) return false;
                const v = item.value;
                return typeof v === "number" && Number.isFinite(v) && v !== 0;
              }),
            cursor: true,
          }}
        >
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
              {...moneyYAxisProps(displayUnit, compactAxis)}
            />
            <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
            {currentPeriodX != null ? renderPeriodRefLine({ x: currentPeriodX }) : null}
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
              stroke={TOTAL_LINE_STROKE}
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
            />
            {yearAverages && showYearAverages ? (
              // Invisible series: puts the year average in the tooltip; the segments draw it.
              <Line
                type="linear"
                dataKey={YEAR_AVERAGE_KEY}
                name={YEAR_AVERAGE_KEY}
                stroke={TOTAL_LINE_STROKE}
                strokeOpacity={0}
                dot={false}
                activeDot={false}
                legendType="none"
                isAnimationActive={false}
              />
            ) : null}
            {showYearAverages
              ? yearAverageSegments.map((seg) => (
                  <ReferenceLine
                    key={`year-avg-${seg.year}`}
                    segment={[
                      { x: seg.first, y: seg.avg },
                      { x: seg.last, y: seg.avg },
                    ]}
                    stroke={TOTAL_LINE_STROKE}
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                    strokeOpacity={0.85}
                  />
                ))
              : null}
        </AppComposedChart>
      </div>
    </section>
  );
}
