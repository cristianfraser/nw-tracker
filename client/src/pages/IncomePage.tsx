import { useMemo } from "react";
import { PageGridTile } from "../components/layout/PageGridTile";
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
import { loadableClass } from "../components/ui/Loadable";
import { useIncome } from "../queries/hooks";
import { useTranslation } from "../i18n";
import {
  buildIncomeDisplayRows,
  rollupIncomeChartPointsByYear,
  rollupIncomeMonthRowsByYear,
} from "../incomeAggregates";
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
  const allRows = useMemo(() => (data ? buildIncomeDisplayRows(data) : []), [data]);

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
        salary: m.salary_clp,
        severance: m.severance_clp,
        parent_gift: m.parent_gift_clp,
        rent: m.rent_clp,
        other: m.other_clp,
        total: m.total_clp,
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

  const monthTableRows = useMemo(() => {
    if (!aggregates) return [];
    // Tables include full history (newest first); the chart's Rango only scopes the chart.
    const asc =
      tableGranularity === "year" ? rollupIncomeMonthRowsByYear(aggregates.months) : aggregates.months;
    return [...asc].reverse();
  }, [aggregates, tableGranularity]);

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
        <IncomeMonthTable
          rows={monthTableRows}
          displayUnit={displayUnit}
          periodGranularity={tableGranularity}
          loading={loading}
        />
      </PageGridTile>

      <PayrollBreakdownSection breakdown={data?.payroll_breakdown} displayUnit={displayUnit} loading={loading} />

      <PageGridTile id="work-earnings">
        <h3>
          {t("workEarnings.sectionTitle")}
        </h3>
        <WorkEarningsTable
          rows={data?.work_earnings ?? []}
          displayUnit={displayUnit}
          checks={data?.payslip_checks}
          loading={loading}
        />
      </PageGridTile>

      <PageGridTile id="all-lines">
        <h3>{t("income.sectionAllLines")}</h3>
        <IncomeAllLinesTable rows={allRows} displayUnit={displayUnit} loading={loading} />
      </PageGridTile>

      <PageGridTile id="refunds">
        <h3>
          {t("income.sectionRefunds")}
        </h3>
        <p className="muted" style={{ fontSize: "var(--font-size-prose)", marginTop: 0 }}>
          {t("income.refundsHint")}
        </p>
        <IncomeRefundLinesTable rows={data?.refund_lines ?? []} displayUnit={displayUnit} loading={loading} />
      </PageGridTile>

      <PageGridTile id="filtered">
        <h3>
          {t("income.sectionFiltered")}
        </h3>
        <IncomeFilteredLinesTable rows={data?.filtered_lines ?? []} displayUnit={displayUnit} loading={loading} />
      </PageGridTile>

      <PageGridTile id="excluded">
        <h3>
          {t("income.sectionExcluded")}
        </h3>
        <IncomeExcludedLinesTable rows={data?.excluded_lines ?? []} displayUnit={displayUnit} loading={loading} />
      </PageGridTile>
    </>
  );
}
