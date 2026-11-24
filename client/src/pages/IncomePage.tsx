import { useMemo, useState } from "react";
import { PageGridTile } from "../components/layout/PageGridTile";
import { IncomeMonthlyChart } from "../components/charts/IncomeMonthlyChart";
import { IncomeMonthList } from "../components/income/IncomeMonthList";
import { IncomeSideLists } from "../components/income/IncomeSideLists";
import { PayslipList } from "../components/income/PayslipList";
import { PayrollBreakdownSection } from "../components/income/PayrollBreakdownSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { loadableClass } from "../components/ui/Loadable";
import { useIncome } from "../queries/hooks";
import { useTranslation } from "../i18n";
import { rollupIncomeChartPointsByYear } from "../incomeAggregates";
import {
  flowTableGranularity,
  formatFlowMoney,
  sumChartPointsField,
} from "../flowsDisplay";
import { clipMonthsThenRollup, clipPointsToTimeRange } from "../timeRange";

export function IncomePage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.income.chart", "month", "3y");
  const metricsPeriod = chartPrefs.period;
  const timeRange = chartPrefs.range;
  const chartControls = (
    <SurfaceControls
      period={chartPrefs.period}
      onPeriodChange={chartPrefs.setPeriod}
      range={chartPrefs.range}
      onRangeChange={chartPrefs.setRange}
    />
  );
  const chartGranularity = metricsPeriod;
  // The month-detail table owns its período (month/year) and always covers full history.
  const tablePrefs = useSurfacePrefs("flows.income.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    tablePrefs.period
  );
  const { data, error } = useIncome(displayUnit);
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  // The frame renders with zero totals and no rows until the payload arrives.
  const loading = !data;

  // Month rows, day points and the total are the server's (the overview's own income rule).
  const aggregates = data?.aggregates ?? null;
  // A salary line's «receipt» link shows its payslip in the payslip list.
  const [payslipFocus, setPayslipFocus] = useState<{ payslipId: number; seq: number } | null>(null);

  const chartPoints = useMemo(() => {
    if (!aggregates) return [];
    if (chartGranularity === "day") {
      return clipPointsToTimeRange(aggregates.days, timeRange);
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      aggregates.months.map((m) => ({
        as_of_date: m.as_of_date,
        salary: m.salary,
        severance: m.severance,
        parent_gift: m.parent_gift,
        rent: m.rent,
        other: m.other,
        total: m.total,
      })),
      chartGranularity,
      timeRange,
      rollupIncomeChartPointsByYear
    );
  }, [aggregates, chartGranularity, timeRange]);

  /**
   * "En el rango" companion (headline total stays full history): the plotted points'
   * sum, the same at month and year grain since the yearly rows are built from the in-range months.
   */
  const rangeTotal = useMemo(() => sumChartPointsField(chartPoints, "total"), [chartPoints]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsIncome")}</h2>

      <p className={loadableClass(loading, "muted")}>
        {t("income.totalLabel")}{" "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {formatFlowMoney(aggregates?.total ?? 0, displayUnit)}
        </span>
        {timeRange !== "total" ? (
          <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "var(--font-size-prose)" }}>
            · {t("flows.rangeTotalLabel")}{" "}
            <span className="mono">{formatFlowMoney(rangeTotal, displayUnit)}</span>
          </span>
        ) : null}
      </p>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <IncomeMonthlyChart
          controls={chartControls}
          title={t("income.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
          loading={loading}
        />
      </div>

      <PageGridTile id="monthly">
        <div className="chart-panel-title-row">
          <h3>{t("income.sectionMonthly")}</h3>
          <SurfaceControls
            period={tablePrefs.period}
            onPeriodChange={tablePrefs.setPeriod}
            periodOptions={["month", "year"]}
          />
        </div>
        <IncomeMonthList
          data={data}
          granularity={tableGranularity}
          displayUnit={displayUnit}
          loading={loading}
          onOpenPayslip={(payslipId) => setPayslipFocus((prev) => ({ payslipId, seq: (prev?.seq ?? 0) + 1 }))}
        />
      </PageGridTile>

      <PayrollBreakdownSection breakdown={data?.payroll_breakdown} displayUnit={displayUnit} loading={loading} />

      <PageGridTile id="work-earnings">
        <PayslipList
          rows={data?.work_earnings ?? []}
          breakdown={data?.payroll_breakdown}
          checks={data?.payslip_checks ?? []}
          displayUnit={displayUnit}
          loading={loading}
          focus={payslipFocus}
        />
      </PageGridTile>

      <PageGridTile id="side-lists">
        <IncomeSideLists data={data} displayUnit={displayUnit} loading={loading} />
      </PageGridTile>
    </>
  );
}
