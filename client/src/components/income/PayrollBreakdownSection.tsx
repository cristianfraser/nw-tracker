import { useMemo } from "react";
import { Bar, Legend, Line, XAxis, YAxis } from "recharts";
import { useTranslation } from "../../i18n";
import { flowPeriodLabel, formatFlowMoney } from "../../flowsDisplay";
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
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";

const CHART_ANIM_MS = 90;
const PAGE_SIZE = 12;

/** Stands in for the server payload while it loads: the frame renders with no rows. */
const EMPTY_BREAKDOWN: PayrollBreakdownPayload = { payslips: [], months: [], years: [] };

/** Stacked bottom to top: what reached the account, then what was taken from gross pay. */
const STACK: readonly { field: PayrollBreakdownField; color: string }[] = [
  { field: "net", color: "#22c55e" },
  { field: "pension", color: "#3b82f6" },
  { field: "voluntary_pension", color: "#60a5fa" },
  { field: "unemployment", color: "#818cf8" },
  { field: "pension_commission", color: "#f59e0b" },
  { field: "health", color: "#14b8a6" },
  { field: "income_tax", color: "#ef4444" },
  { field: "other_deductions", color: "#64748b" },
];

const TABLE_COLUMNS: readonly PayrollBreakdownField[] = [
  "gross",
  "net",
  "pension",
  "pension_commission",
  "health",
  "unemployment",
  "income_tax",
  "voluntary_pension",
  "other_deductions",
];

function pick(row: PayrollBreakdownRow, field: PayrollBreakdownField, unit: DisplayUnit): number {
  return unit === "usd" ? row.values[field].usd : row.values[field].clp;
}

function periodEndYmd(period: string): string {
  if (period.length === 4) return `${period}-12-31`;
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * «Bruto vs líquido»: each payroll month's (or year's) gross pay as net pay plus every deduction,
 * and the same figures as a table. Built by the server (`payroll_breakdown`); this only picks the
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
  const tablePrefs = useSurfacePrefs("income.payroll.table", "year", "total");
  const chartGranularity = chartPrefs.period === "year" ? "year" : "month";
  const tableGranularity = tablePrefs.period === "year" ? "year" : "month";
  const label = (f: PayrollBreakdownField) => t(`income.payroll.fields.${f}`);

  const points = useMemo(() => {
    const rows = chartGranularity === "year" ? breakdown.years : breakdown.months;
    const all = rows.map((r) => {
      const point: Record<string, string | number> = { as_of_date: periodEndYmd(r.period) };
      for (const s of STACK) point[s.field] = pick(r, s.field, displayUnit);
      point.gross = pick(r, "gross", displayUnit);
      return point as { as_of_date: string } & Record<string, number | string>;
    });
    // Months (or years) with no payslip are drawn as empty, so the axis keeps calendar time.
    const dense = densifyRecordsByCalendarPeriod(all as Record<string, string | number | null>[], {
      granularity: chartGranularity,
      dateKey: "as_of_date",
      fillMissing: { zeroKeys: [...STACK.map((s) => s.field), "gross"] },
    }) as typeof all;
    return clipPointsToTimeRange(dense, chartPrefs.range);
  }, [breakdown, chartGranularity, chartPrefs.range, displayUnit]);

  const yScale = useMemo(() => buildNiceYAxis(0, Math.max(0, ...points.map((p) => Number(p.gross)))), [points]);
  const xAxis = useMemo(
    () => resolvePeriodXAxis(extractSortedAsOfDates(points as Record<string, string | number | null>[]), chartGranularity),
    [points, chartGranularity]
  );

  const tableRows = useMemo(
    () => [...(tableGranularity === "year" ? breakdown.years : breakdown.months)].reverse(),
    [breakdown, tableGranularity]
  );
  const { page, setPage, pageRows, total } = useClientPagination(tableRows, PAGE_SIZE);

  if (breakdown.months.length === 0 && !loading) return null;

  return (
    <section style={{ marginBottom: "1.5rem" }}>
      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack" style={{ marginBottom: "1rem" }}>
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
              <YAxis domain={yScale.domain} ticks={yScale.ticks} {...moneyYAxisProps(displayUnit, compactAxis)} />
              <Legend
                wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
                formatter={(value) => (
                  <span style={{ color: "var(--muted, #94a3b8)" }}>{label(String(value) as PayrollBreakdownField)}</span>
                )}
              />
              {STACK.map((s) => (
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

      <div className="chart-panel-title-row">
        <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t("income.payroll.tableTitle")}</h3>
        <SurfaceControls period={tablePrefs.period} onPeriodChange={tablePrefs.setPeriod} periodOptions={["month", "year"]} />
      </div>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
        <Table
          tableStyle={{ fontSize: "0.85rem" }}
          header={
            <thead>
              <tr>
                <th>{t("income.payroll.colPeriod")}</th>
                {TABLE_COLUMNS.map((f) => (
                  <th key={f}>{label(f)}</th>
                ))}
              </tr>
            </thead>
          }
        >
          {pageRows.map((row) => (
            <tr key={row.period}>
              <td className="mono">{flowPeriodLabel(row.period, tableGranularity)}</td>
              {TABLE_COLUMNS.map((f) => (
                <td key={f} className={f === "gross" || f === "net" ? "mono" : "mono muted"}>
                  {formatFlowMoney(pick(row, f, displayUnit), displayUnit)}
                </td>
              ))}
            </tr>
          ))}
        </Table>
      </PaginatedTable>
    </section>
  );
}
