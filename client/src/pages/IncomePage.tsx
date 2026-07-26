import { useMemo } from "react";
import { IncomeMonthlyChart } from "../components/charts/IncomeMonthlyChart";
import { IncomeAllLinesTable } from "../components/income/IncomeAllLinesTable";
import { IncomeExcludedLinesTable } from "../components/income/IncomeExcludedLinesTable";
import { IncomeFilteredLinesTable } from "../components/income/IncomeFilteredLinesTable";
import { IncomeMonthTable } from "../components/income/IncomeMonthTable";
import { WorkEarningsTable } from "../components/income/WorkEarningsTable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { useIncome } from "../queries/hooks";
import { useTranslation } from "../i18n";
import {
  aggregateIncomeChartPointsByDay,
  aggregateIncomeFromPayload,
  rollupIncomeMonthRowsByYear,
} from "../incomeAggregates";
import {
  flowChartGranularityFromMetricsPeriod,
  flowTableGranularity,
  formatFlowMoney,
  sumChartPointsField,
} from "../flowsDisplay";
import { clipPointsToTimeRange } from "../timeRange";

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
    const base =
      chartGranularity === "day"
        ? aggregateIncomeChartPointsByDay(data!, displayUnit)
        : chartGranularity === "year"
          ? view.chart_yearly
          : view.chart_monthly;
    return clipPointsToTimeRange(base, timeRange);
  }, [chartGranularity, data, displayUnit, view, timeRange]);

  /** "En el rango" companion (headline `view.total` stays full history). */
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
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        {t("income.intro")}
      </p>

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
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          {t("income.monthlyDetailHint")}
        </p>
        <IncomeMonthTable
          rows={monthTableRows}
          displayUnit={displayUnit}
          periodGranularity={tableGranularity}
        />
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("workEarnings.sectionTitle")}
        </h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          {t("workEarnings.sectionHint")}
        </p>
        <WorkEarningsTable rows={data.work_earnings} displayUnit={displayUnit} />
      </section>

      <section>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("income.sectionAllLines")}</h3>
        <IncomeAllLinesTable rows={view.all_rows} displayUnit={displayUnit} />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("income.sectionFiltered")}
        </h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          {t("income.sectionFilteredHint")}
        </p>
        <IncomeFilteredLinesTable rows={data.filtered_lines} displayUnit={displayUnit} />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
          {t("income.sectionExcluded")}
        </h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          {t("income.sectionExcludedHint")}
        </p>
        <IncomeExcludedLinesTable rows={data.excluded_lines} displayUnit={displayUnit} />
      </section>
    </>
  );
}
