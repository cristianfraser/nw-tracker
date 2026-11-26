import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import type { DisplayUnit } from "../../queries/keys";
import type { PayrollBreakdownField, PayrollBreakdownPayload, PayrollBreakdownRow } from "../../types";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { clipPointsToTimeRange } from "../../timeRange";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { SurfaceControls } from "../ui/SurfaceControls";
import { ChartPanelTitleRow } from "../charts/ChartPanelTitleRow";
import { ChartEmptyState } from "../charts/ChartEmptyState";
import { loadableClass } from "../ui/Loadable";
import { PayrollBreakdownChart } from "../charts/PayrollBreakdownChart";
import { buildNiceYAxis, extractSortedAsOfDates, resolvePeriodXAxis } from "../charts/chartLayout";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import { incomeKindColor, PAYROLL_STACK } from "./incomeColors";

/** The chart series for the severance part of net pay (not a breakdown field). */
const NET_SEVERANCE = "net_severance";

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
  // A series is a breakdown field, or the severance part of net pay (drawn in severance's colour,
  // as in the payslip list; `net` is then the salary part).
  const label = (key: string) =>
    key === NET_SEVERANCE ? t("workEarnings.netSeverance") : t(`income.payroll.fields.${key as PayrollBreakdownField}`);
  const used = useMemo(() => fieldsInUse(breakdown), [breakdown]);
  const hasSeverance = useMemo(() => breakdown.years.some((y) => y.net_severance !== 0), [breakdown]);
  const stack = useMemo(
    () =>
      PAYROLL_STACK.filter((s) => used.has(s.field)).flatMap((s): { key: string; color: string }[] =>
        s.field === "net" && hasSeverance
          ? [
              { key: "net", color: s.color },
              { key: NET_SEVERANCE, color: incomeKindColor("severance") },
            ]
          : [{ key: s.field, color: s.color }]
      ),
    [used, hasSeverance]
  );

  const points = useMemo(() => {
    const rows = chartGranularity === "year" ? breakdown.years : breakdown.months;
    const all = rows.map((r) => {
      const point: Record<string, string | number> = { as_of_date: periodEndYmd(r.period) };
      for (const s of stack) {
        if (s.key === NET_SEVERANCE) point[s.key] = r.net_severance;
        else if (s.key === "net") point[s.key] = r.values.net - r.net_severance;
        else point[s.key] = pick(r, s.key as PayrollBreakdownField, displayUnit);
      }
      point.gross = pick(r, "gross", displayUnit);
      return point as { as_of_date: string } & Record<string, number | string>;
    });
    // Months (or years) with no payslip are drawn as empty, so the axis keeps calendar time.
    const dense = densifyRecordsByCalendarPeriod(all as Record<string, string | number | null>[], {
      granularity: chartGranularity,
      dateKey: "as_of_date",
      fillMissing: { zeroKeys: [...stack.map((s) => s.key), "gross"] },
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
            <PayrollBreakdownChart
              points={points}
              displayUnit={displayUnit}
              xAxis={xAxis}
              yScale={yScale}
              compactAxis={compactAxis}
              stack={stack}
              label={label}
            />
          </div>
          )}
        </section>
      </div>

    </>
  );
}
