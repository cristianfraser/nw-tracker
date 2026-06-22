import { useMemo } from "react";
import { IncomeMonthlyChart } from "../components/charts/IncomeMonthlyChart";
import { IncomeAllLinesTable } from "../components/income/IncomeAllLinesTable";
import { IncomeMonthTable } from "../components/income/IncomeMonthTable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useIncome } from "../queries/hooks";
import { useTranslation } from "../i18n";
import {
  aggregateIncomeFromPayload,
  rollupIncomeMonthRowsByYear,
} from "../incomeAggregates";
import {
  flowChartGranularityFromMetricsPeriod,
  formatFlowMoney,
} from "../flowsDisplay";

export function IncomePage() {
  const { t } = useTranslation();
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const chartGranularity = flowChartGranularityFromMetricsPeriod(metricsPeriod);
  const { data, error } = useIncome();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const view = useMemo(
    () => (data ? aggregateIncomeFromPayload(data, displayUnit) : null),
    [data, displayUnit]
  );

  const chartPoints = useMemo(() => {
    if (!view) return [];
    return chartGranularity === "year" ? view.chart_yearly : view.chart_monthly;
  }, [chartGranularity, view]);

  const monthTableRows = useMemo(() => {
    if (!view) return [];
    if (chartGranularity === "month") return view.by_month;
    const asc = [...view.by_month].reverse();
    return [...rollupIncomeMonthRowsByYear(asc)].reverse();
  }, [chartGranularity, view]);

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
          periodGranularity={chartGranularity}
        />
      </section>

      <section>
        <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("income.sectionAllLines")}</h3>
        <IncomeAllLinesTable rows={view.all_rows} displayUnit={displayUnit} />
      </section>
    </>
  );
}
