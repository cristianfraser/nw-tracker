import { useMemo } from "react";
import { IncomeMonthlyChart } from "../components/charts/IncomeMonthlyChart";
import { IncomeAllLinesTable } from "../components/income/IncomeAllLinesTable";
import { IncomeRefundLinesTable } from "../components/income/IncomeRefundLinesTable";
import { IncomeExcludedLinesTable } from "../components/income/IncomeExcludedLinesTable";
import { IncomeFilteredLinesTable } from "../components/income/IncomeFilteredLinesTable";
import { IncomeMonthTable } from "../components/income/IncomeMonthTable";
import { WorkEarningsTable } from "../components/income/WorkEarningsTable";
import { PayrollBreakdownSection } from "../components/income/PayrollBreakdownSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { useIncome } from "../queries/hooks";
import { useTranslation } from "../i18n";
import {
  aggregateIncomeChartPointsByDay,
  aggregateIncomeFromPayload,
  rollupIncomeChartPointsByYear,
  rollupIncomeMonthRowsByYear,
} from "../incomeAggregates";
import {
  flowChartGranularityFromMetricsPeriod,
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
  const chartGranularity = flowChartGranularityFromMetricsPeriod(metricsPeriod);
  // The month-detail table owns its período (month/year) and always covers full history.
  const tablePrefs = useSurfacePrefs("flows.income.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    flowChartGranularityFromMetricsPeriod(tablePrefs.period)
  );
  const { data, error } = useIncome();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const view = useMemo(
    () => (data ? aggregateIncomeFromPayload(data, displayUnit) : null),
    [data, displayUnit]
  );

  const chartPoints = useMemo(() => {
    if (!view) return [];
    if (chartGranularity === "day") {
      return clipPointsToTimeRange(aggregateIncomeChartPointsByDay(data!, displayUnit), timeRange);
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      view.chart_monthly,
      chartGranularity,
      timeRange,
      rollupIncomeChartPointsByYear
    );
  }, [chartGranularity, data, displayUnit, view, timeRange]);

  /**
   * "En el rango" companion (headline `view.total` stays full history): the plotted points'
   * sum, the same at month and year grain since the yearly rows are built from the in-range months.
   */
  const rangeTotal = useMemo(() => sumChartPointsField(chartPoints, "total"), [chartPoints]);

  const monthTableRows = useMemo(() => {
    if (!view) return [];
    // Tables include full history; the chart's Rango only scopes the chart.
    if (tableGranularity !== "year") return view.by_month;
    const asc = [...view.by_month].reverse();
    return [...rollupIncomeMonthRowsByYear(asc)].reverse();
  }, [tableGranularity, view]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data || !view) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsIncome")}</h2>

      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("income.totalLabel")}{" "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {formatFlowMoney(view.total, displayUnit)}
        </span>
        {timeRange !== "total" ? (
          <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
            · {t("flows.rangeTotalLabel")}{" "}
            <span className="mono">{formatFlowMoney(rangeTotal, displayUnit)}</span>
          </span>
        ) : null}
      </p>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <IncomeMonthlyChart
          controls={chartControls}
          title={t("income.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
        />
      </div>

      <section style={{ marginBottom: "1.5rem" }}>
        <div className="chart-panel-title-row">
          <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t("income.sectionMonthly")}</h3>
          <SurfaceControls
            period={tablePrefs.period}
            onPeriodChange={tablePrefs.setPeriod}
            periodOptions={["month", "year"]}
          />
        </div>
        <IncomeMonthTable
          rows={monthTableRows}
          displayUnit={displayUnit}
          periodGranularity={tableGranularity}
        />
      </section>

      <PayrollBreakdownSection breakdown={data.payroll_breakdown} displayUnit={displayUnit} />

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("workEarnings.sectionTitle")}
        </h3>
        <WorkEarningsTable rows={data.work_earnings} displayUnit={displayUnit} checks={data.payslip_checks} />
      </section>

      <section>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("income.sectionAllLines")}</h3>
        <IncomeAllLinesTable rows={view.all_rows} displayUnit={displayUnit} />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("income.sectionRefunds")}
        </h3>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
          {t("income.refundsHint")}
        </p>
        <IncomeRefundLinesTable rows={data.refund_lines} displayUnit={displayUnit} />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("income.sectionFiltered")}
        </h3>
        <IncomeFilteredLinesTable rows={data.filtered_lines} displayUnit={displayUnit} />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("income.sectionExcluded")}
        </h3>
        <IncomeExcludedLinesTable rows={data.excluded_lines} displayUnit={displayUnit} />
      </section>
    </>
  );
}
