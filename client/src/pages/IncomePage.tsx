import { useMemo } from "react";
import { IncomeMonthlyChart } from "../components/charts/IncomeMonthlyChart";
import { IncomeAllLinesTable } from "../components/income/IncomeAllLinesTable";
import { IncomeExcludedLinesTable } from "../components/income/IncomeExcludedLinesTable";
import { IncomeFilteredLinesTable } from "../components/income/IncomeFilteredLinesTable";
import { IncomeMonthTable } from "../components/income/IncomeMonthTable";
import { WorkEarningsTable } from "../components/income/WorkEarningsTable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
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
import { clipPointsToTimeRange, timeRangeCutoffYmd } from "../timeRange";

export function IncomePage() {
  const { t } = useTranslation();
  const { displayUnit, metricsPeriod, timeRange } = useDisplayPreferences();
  const chartGranularity = flowChartGranularityFromMetricsPeriod(metricsPeriod);
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
    const cutoff = timeRangeCutoffYmd(timeRange);
    const clipped = cutoff ? view.by_month.filter((r) => r.as_of_date >= cutoff) : view.by_month;
    // Tables clamp to month/year even in Diario (the chart is the day surface).
    if (chartGranularity !== "year") return clipped;
    const asc = [...clipped].reverse();
    return [...rollupIncomeMonthRowsByYear(asc)].reverse();
  }, [chartGranularity, view, timeRange]);

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
          title={t("income.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
        />
      </div>

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("income.sectionMonthly")}</h3>
        <p className="muted" style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          {t("income.monthlyDetailHint")}
        </p>
        <IncomeMonthTable
          rows={monthTableRows}
          displayUnit={displayUnit}
          periodGranularity={flowTableGranularity(chartGranularity)}
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
