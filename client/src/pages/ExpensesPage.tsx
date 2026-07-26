import { useMemo } from "react";
import { useFlowsCreditCardExpenses } from "../queries/hooks";
import { CreditCardGroupExpensesChart } from "../components/charts/CreditCardGroupExpensesChart";
import { GroupExpensesMonthTable } from "../components/credit-card/GroupExpensesMonthTable";
import { BigExpenseGroupsSection } from "../components/credit-card/BigExpenseGroupsSection";
import { CreditCardUnclassifiedExpensesTable } from "../components/credit-card/CreditCardUnclassifiedExpensesTable";
import { CreditCardDepositMatchedExpensesTable } from "../components/credit-card/CreditCardDepositMatchedExpensesTable";
import { CreditCardFacturadoFinancingManager } from "../components/credit-card/CreditCardFacturadoFinancingManager";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { useTranslation } from "../i18n";
import {
  aggregateGastosFromLines,
  computeExpensesTotal,
  rollupExpenseMonthRowsByYear,
} from "../ccExpenseGastosAggregate";
import { aggregateGastosChartPointsByDay } from "../ccExpenseGastosDaily";
import {
  flowChartGranularityFromMetricsPeriod,
  flowTableGranularity,
  formatFlowMoney,
  rollupChartPointsByYear,
} from "../flowsDisplay";
import { timeRangeCutoffYmd } from "../timeRange";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import { useCcExpenseExcludedBigGroups } from "../useCcExpenseExcludedBigGroups";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "../ccExpenseLineBuckets";
import { chartCategorySlugsForFlowsExpenses } from "../expenseDepositLinks";
import { activeBigGroupSlugs, bigGroupsWithUsage } from "../ccExpenseBigGroupTotals";

/** Tarjeta de crédito (grupo Pasivos): líneas de estado de cuenta, todos los signos. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.expenses.chart", "month", "3y");
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
  const tablePrefs = useSurfacePrefs("flows.expenses.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    flowChartGranularityFromMetricsPeriod(tablePrefs.period)
  );
  const { data, error } = useFlowsCreditCardExpenses();
  const { installmentMode, setInstallmentMode } = useCcInstallmentGastosMode();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const chartCategorySlugs = useMemo(
    () =>
      chartCategorySlugsForFlowsExpenses(
        (data?.categories ?? [])
          .map((c) => c.slug)
          .filter((slug) => !CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(slug))
      ),
    [data?.categories]
  );

  const activeBigGroups = useMemo(
    () => (data ? activeBigGroupSlugs(data.lines) : []),
    [data]
  );

  const { excludedBigGroups, isExcluded, toggleExcluded } =
    useCcExpenseExcludedBigGroups(activeBigGroups);

  const bigGroupUsage = useMemo(
    () =>
      data
        ? bigGroupsWithUsage(data.lines, data.big_groups ?? [], installmentMode)
        : [],
    [data, installmentMode]
  );

  const view = useMemo(() => {
    if (!data) return null;
    const tableAgg = aggregateGastosFromLines(
      data.lines,
      chartCategorySlugs,
      installmentMode,
      undefined,
      displayUnit
    );
    const chartAgg = aggregateGastosFromLines(
      data.lines,
      chartCategorySlugs,
      installmentMode,
      excludedBigGroups,
      displayUnit
    );
    const totals = computeExpensesTotal(data.lines, installmentMode, displayUnit);
    return { table: tableAgg, chart: chartAgg, ...totals };
  }, [chartCategorySlugs, data, displayUnit, excludedBigGroups, installmentMode]);

  /**
   * Latest month (YYYY-MM) with any real spend. Trailing months beyond this are dropped so the
   * table/chart don't show an empty future tail — installment cuota lines create future month
   * buckets that are $0 in Total mode; Cuotas mode keeps them because they carry real gastos.
   */
  const latestNonEmptyMonth = useMemo(() => {
    if (!view) return null;
    let latest: string | null = null;
    for (const row of view.table.by_month) {
      if (row.gastos_real_mes_clp !== 0 && (latest == null || row.period_month > latest)) {
        latest = row.period_month;
      }
    }
    return latest;
  }, [view]);

  const chartPoints = useMemo(() => {
    if (!view) return [];
    const cutoff = timeRangeCutoffYmd(timeRange);
    if (chartGranularity === "day") {
      if (!data) return [];
      return aggregateGastosChartPointsByDay(
        data.lines,
        chartCategorySlugs,
        installmentMode,
        excludedBigGroups,
        displayUnit,
        data.cuota_pay_by_iso
      ).filter((p) => cutoff == null || p.as_of_date >= cutoff);
    }
    const monthly = view.chart.chart_monthly_by_category.filter(
      (p) =>
        (latestNonEmptyMonth == null || p.as_of_date.slice(0, 7) <= latestNonEmptyMonth) &&
        (cutoff == null || p.as_of_date >= cutoff)
    );
    if (chartGranularity === "year") {
      return rollupChartPointsByYear(monthly, chartCategorySlugs);
    }
    return monthly;
  }, [
    chartCategorySlugs,
    chartGranularity,
    data,
    displayUnit,
    excludedBigGroups,
    installmentMode,
    latestNonEmptyMonth,
    view,
    timeRange,
  ]);

  /** Unfiltered totals — stack order stays stable when big groups are excluded from display. */
  const chartSortPoints = useMemo(() => {
    if (!view) return [];
    const cutoff = timeRangeCutoffYmd(timeRange);
    const monthly = view.table.chart_monthly_by_category.filter(
      (p) =>
        (latestNonEmptyMonth == null || p.as_of_date.slice(0, 7) <= latestNonEmptyMonth) &&
        (cutoff == null || p.as_of_date >= cutoff)
    );
    if (chartGranularity === "year") {
      return rollupChartPointsByYear(monthly, chartCategorySlugs);
    }
    return monthly;
  }, [chartCategorySlugs, chartGranularity, latestNonEmptyMonth, view, timeRange]);

  /** Table rows: FULL history (no range clip), rolled to the table's own período. */
  const monthTableRows = useMemo(() => {
    if (!view) return [];
    const bounded = view.table.by_month.filter(
      (r) => latestNonEmptyMonth == null || r.period_month <= latestNonEmptyMonth
    );
    if (tableGranularity === "month") return bounded;
    const asc = [...bounded].reverse();
    return [...rollupExpenseMonthRowsByYear(asc)].reverse();
  }, [tableGranularity, latestNonEmptyMonth, view]);

  /** "En el rango" companion follows the CHART's Rango (headline `view.total` stays full). */
  const rangeTotals = useMemo(() => {
    if (!view) return { total: 0, total_real: 0 };
    const cutoff = timeRangeCutoffYmd(timeRange);
    let total = 0;
    let total_real = 0;
    for (const r of view.table.by_month) {
      if (latestNonEmptyMonth != null && r.period_month > latestNonEmptyMonth) continue;
      if (cutoff != null && r.as_of_date < cutoff) continue;
      total += r.gastos_mes_clp;
      total_real += r.gastos_real_mes_clp;
    }
    return { total, total_real };
  }, [latestNonEmptyMonth, view, timeRange]);

  const chartFilterActive = bigGroupUsage.some((g) => isExcluded(g.slug));

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data || !view) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsExpenses")}</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        {t("expenses.creditCard.intro")}
      </p>

      <div
        className="chart-controls"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem 1rem",
          marginBottom: "1rem",
        }}
      >
        <span className="label-inline">{t("expenses.creditCard.installmentModeLabel")}</span>
        <label className="radio-pill">
          <input
            type="radio"
            name="cc-installment-gastos-mode"
            checked={installmentMode === "split"}
            onChange={() => setInstallmentMode("split")}
          />
          {t("expenses.creditCard.installmentModeSplit")}
        </label>
        <label className="radio-pill">
          <input
            type="radio"
            name="cc-installment-gastos-mode"
            checked={installmentMode === "total"}
            onChange={() => setInstallmentMode("total")}
          />
          {t("expenses.creditCard.installmentModeTotal")}
        </label>
        <span style={{ marginLeft: "auto" }}>
          <CreditCardFacturadoFinancingManager lines={data.lines} />
        </span>
      </div>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: chartFilterActive ? "0.35rem" : "1.5rem" }}
      >
        <CreditCardGroupExpensesChart
          controls={chartControls}
          title={t("expenses.creditCard.chartTitle")}
          points={chartPoints}
          categorySortPoints={chartSortPoints}
          categories={data.categories}
          displayUnit={displayUnit}
          xAxisGranularity={chartGranularity}
        />
      </div>
      {chartFilterActive ? (
        <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "1.5rem" }}>
          {t("expenses.creditCard.bigGroups.chartFilterHint")}
        </p>
      ) : null}

      <BigExpenseGroupsSection
        lines={data.lines}
        categories={data.categories}
        bigGroups={data.big_groups ?? []}
        installmentMode={installmentMode}
        isExcluded={isExcluded}
        toggleExcluded={toggleExcluded}
      />

      <div className="chart-panel-title-row" style={{ marginBottom: "0.5rem" }}>
      <h3 style={{ fontSize: "1.1rem", margin: 0 }}>
        {t(
          tableGranularity === "year"
            ? "accountDetail.yearlyDetailTitle"
            : "accountDetail.monthlyDetailTitle"
        )}
        <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
          {formatFlowMoney(view.total, displayUnit)}
          {view.total_real !== view.total ? (
            <>
              {" · "}
              {t("expenses.creditCard.colMonthExpenseReal")}:{" "}
              {formatFlowMoney(view.total_real, displayUnit)}
            </>
          ) : null}
          {timeRange !== "total" ? (
            <>
              {" · "}
              {t("flows.rangeTotalLabel")}: {formatFlowMoney(rangeTotals.total, displayUnit)}
            </>
          ) : null}
        </span>
      </h3>
      <SurfaceControls
        period={tablePrefs.period}
        onPeriodChange={tablePrefs.setPeriod}
        periodOptions={["month", "year"]}
      />
      </div>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("expenses.creditCard.monthlyDetailHint")}
      </p>
      <GroupExpensesMonthTable
        rows={monthTableRows}
        lines={data.lines}
        categories={data.categories}
        bigGroups={data.big_groups ?? []}
        installmentMode={installmentMode}
        displayUnit={displayUnit}
        periodGranularity={tableGranularity}
      />

      <CreditCardUnclassifiedExpensesTable
        lines={data.lines}
        categories={data.categories}
        bigGroups={data.big_groups ?? []}
      />

      <CreditCardDepositMatchedExpensesTable lines={data.lines} categories={data.categories} />
    </>
  );
}
