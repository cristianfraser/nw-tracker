import type { ReactNode } from "react";
import { ChartEmptyState } from "./ChartEmptyState";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { loadableClass } from "../ui/Loadable";
import { Bar, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useCallback, useId, useMemo, useState } from "react";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { chileTodayYmd } from "../../calendarMonth";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import { useTranslation } from "../../i18n";
import type { ExpenseYearMonthlyAverage } from "../../types";
import { EXPENSE_CHART_TOTAL_KEY, expenseCategoryChartPointTotal } from "../../expenseDepositLinks";
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
/** Row key carrying the sum of the series the legend leaves shown (tooltip only). */
const SHOWN_TOTAL_KEY = "__shown_total";

type ExpenseChartStyle = "stacked_bar" | "line";

export type StackedExpenseChartRow = { as_of_date: string } & Record<string, string | number>;

/** One stacked series. Several series may share a legend entry (`legendKey`), hidden together. */
export type StackedExpenseSeries = {
  dataKey: string;
  /** Tooltip name (translated by the caller at render). */
  label: string;
  color: string;
  legendKey: string;
};

export type StackedExpenseLegendEntry = { key: string; label: string; color: string };

/**
 * Stacked monthly expenses with a clickable legend: a click on an entry hides its series (the
 * Total line keeps them — hiding changes the stack, never the total), a bar/line switch and
 * optional per-year average segments. The tooltip adds the total of the series shown whenever it
 * can differ from the Total line (an entry hidden, or no Total line). The Expenses page draws its categories with it, the
 * real-estate page its bill kinds per place.
 */
export function StackedExpensesChart({
  title,
  titleAs = "h3",
  controls,
  points,
  series,
  legend,
  emptyMessage,
  displayUnit = "clp",
  xAxisGranularity = "month",
  extendThroughYmd,
  yearAverages,
  showTotalLine = true,
  loading,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  /** Per-surface Período/Rango controls, rendered next to the title. */
  controls?: ReactNode;
  points: readonly StackedExpenseChartRow[];
  /** Series in stacking order (bottom first). */
  series: readonly StackedExpenseSeries[];
  /** Legend entries in display order; each toggles every series with its key. */
  legend: readonly StackedExpenseLegendEntry[];
  emptyMessage: string;
  displayUnit?: DisplayUnit;
  xAxisGranularity?: "month" | "year";
  /** Extend the axis with empty periods through this day (the Expenses page: today). */
  extendThroughYmd?: string;
  /**
   * Per-year average monthly gastos, drawn as one flat segment per year over its months on the
   * axis (with a toggle). Null/absent = not offered (yearly chart, short Rango).
   */
  yearAverages?: Readonly<Record<string, ExpenseYearMonthlyAverage>> | null;
  /** Draw the Total line (and its legend entry). */
  showTotalLine?: boolean;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const compactAxis = useIsNarrowViewport();
  const styleRadioName = useId();
  const [chartStyle, setChartStyle] = useState<ExpenseChartStyle>("stacked_bar");
  const [hiddenLegendKeys, setHiddenLegendKeys] = useState<Set<string>>(() => new Set());
  const [showYearAverages, setShowYearAverages] = useState(true);

  const toggleLegendKey = useCallback((key: string) => {
    setHiddenLegendKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const barKeys = useMemo(() => series.map((s) => s.dataKey), [series]);
  const hiddenDataKeys = useMemo(
    () => new Set(series.filter((s) => hiddenLegendKeys.has(s.legendKey)).map((s) => s.dataKey)),
    [series, hiddenLegendKeys]
  );

  /**
   * The total is taken before legend-hidden series are zeroed: hiding a legend entry changes
   * the stack, never the Total line (or the year averages drawn against it).
   */
  const densePoints = useMemo(() => {
    const displayPoints = points.map((row) => {
      const next: StackedExpenseChartRow = {
        ...row,
        [EXPENSE_CHART_TOTAL_KEY]: expenseCategoryChartPointTotal(row, barKeys),
      };
      for (const key of hiddenDataKeys) next[key] = 0;
      return next;
    });
    return densifyRecordsByCalendarPeriod(
      displayPoints as unknown as Record<string, string | number | null>[],
      {
        granularity: xAxisGranularity,
        dateKey: "as_of_date",
        fillMissing: { zeroKeys: [...barKeys, EXPENSE_CHART_TOTAL_KEY] },
        ...(extendThroughYmd ? { extendThroughYmd } : {}),
      }
    ) as unknown as StackedExpenseChartRow[];
  }, [points, hiddenDataKeys, barKeys, xAxisGranularity, extendThroughYmd]);

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

  const showShownTotal = !showTotalLine || hiddenDataKeys.size > 0;
  const shownKeys = useMemo(() => barKeys.filter((k) => !hiddenDataKeys.has(k)), [barKeys, hiddenDataKeys]);

  /**
   * Chart rows: the dense points plus each month's year average while the line is shown, and the
   * total of the shown series while it can differ from the Total line.
   */
  const chartRows = useMemo(() => {
    if (!showShownTotal && (!yearAverages || !showYearAverages)) return densePoints;
    return densePoints.map((row) => {
      const next: StackedExpenseChartRow = showShownTotal
        ? { ...row, [SHOWN_TOTAL_KEY]: expenseCategoryChartPointTotal(row, shownKeys) }
        : row;
      if (!yearAverages || !showYearAverages) return next;
      const ym = row.as_of_date.slice(0, 7);
      const entry = yearAverages[ym.slice(0, 4)];
      if (!entry || ym < entry.from_ym || ym > entry.through_ym) return next;
      return { ...next, [YEAR_AVERAGE_KEY]: entry.avg };
    });
  }, [densePoints, showShownTotal, shownKeys, showYearAverages, yearAverages]);

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
      // The Total line counts hidden series too; without it the axis fits the shown stack.
      const total = row[EXPENSE_CHART_TOTAL_KEY];
      if (showTotalLine && typeof total === "number" && Number.isFinite(total)) {
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
  }, [densePoints, barKeys, chartStyle, displayUnit, showTotalLine]);

  const TitleTag = titleAs;
  const labelByDataKey = new Map(series.map((s) => [s.dataKey, s.label]));

  if (points.length === 0) {
    return (
      <section className="chart-panel">
        <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
        <ChartEmptyState loading={loading} message={emptyMessage} boxStyle={{ height: 280 }} />
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
        <TitleTag className="chart-panel-title" style={{ margin: 0 }}>
          {title}
        </TitleTag>
        {controls}
        <div className="chart-controls">
          <span className="label-inline">{t("expenses.creditCard.chartStyleLabel")}</span>
          <label className="radio-pill">
            <input
              type="radio"
              name={styleRadioName}
              checked={chartStyle === "stacked_bar"}
              onChange={() => setChartStyle("stacked_bar")}
            />
            {t("expenses.creditCard.chartStyleStacked")}
          </label>
          <label className="radio-pill">
            <input
              type="radio"
              name={styleRadioName}
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
              const key = String(entry.name ?? entry.dataKey ?? "");
              if (key === EXPENSE_CHART_TOTAL_KEY) return t("expenses.creditCard.chartTotal");
              if (key === YEAR_AVERAGE_KEY) return t("expenses.creditCard.chartYearAverage");
              if (key === SHOWN_TOTAL_KEY) return t("expenses.creditCard.chartShownTotal");
              return labelByDataKey.get(key) ?? key;
            },
            mapPayload: (payload) =>
              payload.filter((item) => {
                const key = String(item.dataKey ?? "");
                if (key === EXPENSE_CHART_TOTAL_KEY || key === SHOWN_TOTAL_KEY) return true;
                if (key === YEAR_AVERAGE_KEY) {
                  return typeof item.value === "number" && Number.isFinite(item.value);
                }
                if (hiddenDataKeys.has(key)) return false;
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
          {/* The domain is computed above; the invisible tooltip-only series (shown total, year average)
              must not stretch it. */}
          <YAxis
            domain={yScale.domain}
            ticks={yScale.ticks}
            allowDataOverflow
            {...moneyYAxisProps(displayUnit, compactAxis)}
          />
          <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
          {currentPeriodX != null ? renderPeriodRefLine({ x: currentPeriodX }) : null}
          <Legend
            content={() => (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: "0.35rem 1rem",
                  paddingTop: 8,
                  fontSize: 12,
                  color: "var(--muted, #94a3b8)",
                }}
              >
                {legend.map((entry) => {
                  const hidden = hiddenLegendKeys.has(entry.key);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => toggleLegendKey(entry.key)}
                      aria-pressed={!hidden}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: 0,
                        border: 0,
                        background: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        opacity: hidden ? 0.35 : 1,
                        textDecoration: hidden ? "line-through" : "none",
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: entry.color }} />
                      {entry.label}
                    </button>
                  );
                })}
                {showTotalLine ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 14, height: 2, background: TOTAL_LINE_STROKE }} />
                    {t("expenses.creditCard.chartTotal")}
                  </span>
                ) : null}
              </div>
            )}
          />
          {chartStyle === "stacked_bar"
            ? series.map((s) => (
                <Bar
                  key={s.dataKey}
                  dataKey={s.dataKey}
                  name={s.dataKey}
                  fill={s.color}
                  stackId="gastos"
                  isAnimationActive
                  animationDuration={CHART_ANIM_MS}
                  maxBarSize={22}
                />
              ))
            : series.map((s) => (
                <Line
                  key={s.dataKey}
                  type="monotone"
                  dataKey={s.dataKey}
                  name={s.dataKey}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive
                  animationDuration={CHART_ANIM_MS}
                />
              ))}
          {showTotalLine ? (
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
          ) : null}
          {showShownTotal ? (
            // Invisible series: puts the shown series' total in the tooltip.
            <Line
              type="linear"
              dataKey={SHOWN_TOTAL_KEY}
              name={SHOWN_TOTAL_KEY}
              stroke={TOTAL_LINE_STROKE}
              strokeOpacity={0}
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
          ) : null}
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
