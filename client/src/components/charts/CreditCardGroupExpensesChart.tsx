import {
  Bar,
  CartesianGrid,
  ComposedChart,
  DefaultTooltipContent,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import { useCallback, useMemo, useState } from "react";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { formatClp } from "../../format";
import { ccExpenseCategoryLabel, useTranslation } from "../../i18n";
import type { CcExpenseCategoryDto, FlowCcExpenseCategoryChartPoint } from "../../types";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "../../ccExpenseLineBuckets";
import {
  buildNiceYAxis,
  computeRegularMonthXAxisTicks,
  extractSortedAsOfDates,
  formatLineChartXTick,
  rechartsMoneyYAxisWidth,
  RECHARTS_MONEY_CHART_MARGIN,
} from "./ValuationLineCharts";

const AXIS_LINE_STROKE = "#64748b";
const CHART_ANIM_MS = 90;

type ExpenseChartStyle = "stacked_bar" | "line";

/** Categories shown as stacked bars (excludes no_cuenta/deposits and puts unclassified last). */
function chartCategories(categories: readonly CcExpenseCategoryDto[]): CcExpenseCategoryDto[] {
  const assignable = categories.filter(
    (c) => c.slug !== "unclassified" && !CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(c.slug)
  );
  const unclassified = categories.find((c) => c.slug === "unclassified");
  return unclassified ? [...assignable, unclassified] : assignable;
}

export function CreditCardGroupExpensesChart({
  title,
  points,
  categories,
}: {
  title: string;
  points: readonly FlowCcExpenseCategoryChartPoint[];
  categories: readonly CcExpenseCategoryDto[];
}) {
  const { t } = useTranslation();
  const bars = useMemo(() => chartCategories(categories), [categories]);
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
  const visibleBarKeys = useMemo(
    () => barKeys.filter((k) => !hiddenSlugs.has(k)),
    [barKeys, hiddenSlugs]
  );

  const densePoints = useMemo(
    () =>
      densifyRecordsByCalendarPeriod(
        points as unknown as Record<string, string | number | null>[],
        {
          granularity: "month",
          dateKey: "as_of_date",
          fillMissing: { zeroKeys: barKeys },
        }
      ) as unknown as FlowCcExpenseCategoryChartPoint[],
    [points, barKeys]
  );

  const dates = useMemo(() => extractSortedAsOfDates(densePoints), [densePoints]);
  const xTicks = useMemo(() => computeRegularMonthXAxisTicks(dates), [dates]);

  const yScale = useMemo(() => {
    const keysForScale = visibleBarKeys.length > 0 ? visibleBarKeys : barKeys;
    let maxV = 0;
    for (const row of densePoints) {
      if (chartStyle === "line") {
        for (const k of keysForScale) {
          const v = row[k];
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            maxV = Math.max(maxV, v);
          }
        }
      } else {
        let stack = 0;
        for (const k of keysForScale) {
          const v = row[k];
          if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            stack += v;
          }
        }
        maxV = Math.max(maxV, stack);
      }
    }
    return buildNiceYAxis(0, maxV);
  }, [densePoints, barKeys, visibleBarKeys, chartStyle]);

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
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={densePoints} margin={RECHARTS_MONEY_CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis
              dataKey="as_of_date"
              type="category"
              ticks={xTicks}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(d: string) => formatLineChartXTick(String(d), "month")}
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
              content={(props) => {
                const p = props as TooltipProps<number, string>;
                const payload = (p.payload ?? []).filter(
                  (item) => !hiddenSlugs.has(String(item.dataKey ?? ""))
                );
                return (
                  <DefaultTooltipContent
                    {...p}
                    payload={payload}
                    formatter={(v) => formatClp(typeof v === "number" ? v : Number(v))}
                    labelFormatter={(d) => formatLineChartXTick(String(d), "month")}
                    contentStyle={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                    }}
                  />
                );
              }}
            />
            <Legend
              wrapperStyle={{
                fontSize: 12,
                color: "var(--muted, #94a3b8)",
                paddingTop: 8,
                cursor: "pointer",
              }}
              onClick={(entry) => {
                const key = entry?.dataKey;
                if (typeof key === "string") toggleSeries(key);
              }}
              formatter={(value) => {
                const slug = String(value);
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
                    hide={hiddenSlugs.has(b.slug)}
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
                    hide={hiddenSlugs.has(b.slug)}
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                  />
                ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
