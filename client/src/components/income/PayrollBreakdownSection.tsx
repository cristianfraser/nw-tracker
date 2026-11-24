import { useMemo } from "react";
import { Bar, Legend, Line, XAxis, YAxis } from "recharts";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { PayrollBreakdownField, PayrollBreakdownPayload, PayrollBreakdownRow } from "../../types";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { clipPointsToTimeRange } from "../../timeRange";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { SurfaceControls } from "../ui/SurfaceControls";
import { ChartPanelTitleRow } from "../charts/ChartPanelTitleRow";
import { ChartEmptyState } from "../charts/ChartEmptyState";
import { loadableClass } from "../ui/Loadable";
import { AppComposedChart } from "../charts/AppComposedChart";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  CHART_TICK_STYLE,
  extractSortedAsOfDates,
  moneyYAxisProps,
  resolvePeriodXAxis,
} from "../charts/chartLayout";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import { PAYROLL_STACK } from "./incomeColors";

const CHART_ANIM_MS = 90;

/** Stands in for the server payload while it loads: the frame renders with no rows. */
const EMPTY_BREAKDOWN: PayrollBreakdownPayload = { unit: "clp", payslips: [], months: [], years: [] };

/** The stack's fields some year of the payload carries (the server's figures, only picked here). */
function fieldsInUse(breakdown: PayrollBreakdownPayload): Set<PayrollBreakdownField> {
  const used = new Set<PayrollBreakdownField>(["net"]);
  for (const row of breakdown.years) {
    for (const s of PAYROLL_STACK) if (row.values[s.field] !== 0) used.add(s.field);
  }
  return used;
}

/** A field of a period, in the payload's unit (`breakdown.unit`). */
function pick(row: PayrollBreakdownRow, field: PayrollBreakdownField, _unit: DisplayUnit): number {
  return row.values[field];
}

function periodEndYmd(period: string): string {
  if (period.length === 4) return `${period}-12-31`;
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * «Bruto vs líquido»: each payroll month's (or year's) gross pay as net pay plus every deduction
 * (the same figures per payslip are the payslip list's, `PayslipList`). Built by the server (`payroll_breakdown`); this only picks the
 * display unit and the period. While `loading` it renders its frame dimmed; once loaded it
 * is absent when there is no payslip.
 */
export function PayrollBreakdownSection({
  breakdown: loadedBreakdown,
  displayUnit,
  loading,
}: {
  breakdown?: PayrollBreakdownPayload;
  displayUnit: DisplayUnit;
  loading?: boolean;
}) {
  const breakdown = loadedBreakdown ?? EMPTY_BREAKDOWN;
  const { t } = useTranslation();
  const compactAxis = useIsNarrowViewport();
  const chartPrefs = useSurfacePrefs("income.payroll.chart", "month", "3y");
  const chartGranularity = chartPrefs.period === "year" ? "year" : "month";
  const label = (f: PayrollBreakdownField) => t(`income.payroll.fields.${f}`);
  const used = useMemo(() => fieldsInUse(breakdown), [breakdown]);
  const stack = useMemo(() => PAYROLL_STACK.filter((s) => used.has(s.field)), [used]);

  const points = useMemo(() => {
    const rows = chartGranularity === "year" ? breakdown.years : breakdown.months;
    const all = rows.map((r) => {
      const point: Record<string, string | number> = { as_of_date: periodEndYmd(r.period) };
      for (const s of stack) point[s.field] = pick(r, s.field, displayUnit);
      point.gross = pick(r, "gross", displayUnit);
      return point as { as_of_date: string } & Record<string, number | string>;
    });
    // Months (or years) with no payslip are drawn as empty, so the axis keeps calendar time.
    const dense = densifyRecordsByCalendarPeriod(all as Record<string, string | number | null>[], {
      granularity: chartGranularity,
      dateKey: "as_of_date",
      fillMissing: { zeroKeys: [...stack.map((s) => s.field), "gross"] },
    }) as typeof all;
    return clipPointsToTimeRange(dense, chartPrefs.range);
  }, [breakdown, chartGranularity, chartPrefs.range, displayUnit, stack]);

  const yScale = useMemo(() => buildNiceYAxis(0, Math.max(0, ...points.map((p) => Number(p.gross)))), [points]);
  const xAxis = useMemo(
    () => resolvePeriodXAxis(extractSortedAsOfDates(points as Record<string, string | number | null>[]), chartGranularity),
    [points, chartGranularity]
  );

  if (breakdown.months.length === 0 && !loading) return null;

  return (
    <>
      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <section className="chart-panel">
          <ChartPanelTitleRow
            title={t("income.payroll.chartTitle")}
            titleAs="h3"
            controls={
              <SurfaceControls
                period={chartPrefs.period}
                onPeriodChange={chartPrefs.setPeriod}
                periodOptions={["month", "year"]}
                range={chartPrefs.range}
                onRangeChange={chartPrefs.setRange}
              />
            }
          />
          {points.length === 0 ? (
            <ChartEmptyState loading={loading} message={t("income.chartEmpty")} boxStyle={{ height: 300 }} />
          ) : (
          <div className={loadableClass(loading, "chart-box line-chart-focus-wrap")} style={{ height: 300 }}>
            <AppComposedChart
              data={points}
              tooltip={{
                formatValue: (v) => formatFlowMoney(v, displayUnit),
                formatLabel: (d) => xAxis.formatTooltipTitle(String(d)),
                formatName: (entry) => label(String(entry.name ?? entry.dataKey ?? "") as PayrollBreakdownField),
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
                formatter={(value) => (
                  <span style={{ color: "var(--muted, #94a3b8)" }}>{label(String(value) as PayrollBreakdownField)}</span>
                )}
              />
              {stack.map((s) => (
                <Bar
                  key={s.field}
                  dataKey={s.field}
                  name={s.field}
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
          </div>
          )}
        </section>
      </div>

    </>
  );
}
