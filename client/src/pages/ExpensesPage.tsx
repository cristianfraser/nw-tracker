import { useMemo } from "react";
import { useFlowsExpenses } from "../queries/hooks";
import { CreditCardGroupExpensesChart } from "../components/charts/CreditCardGroupExpensesChart";
import { GroupExpensesMonthTable } from "../components/credit-card/GroupExpensesMonthTable";
import { BigExpenseGroupsSection } from "../components/credit-card/BigExpenseGroupsSection";
import { CreditCardUnclassifiedExpensesTable } from "../components/credit-card/CreditCardUnclassifiedExpensesTable";
import { CreditCardDepositMatchedExpensesTable } from "../components/credit-card/CreditCardDepositMatchedExpensesTable";
import { CreditCardFacturadoFinancingManager } from "../components/credit-card/CreditCardFacturadoFinancingManager";
import { AdditionalCardsSection } from "../components/credit-card/AdditionalCardsSection";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { useTranslation } from "../i18n";
import { aggregateGastosFromLines, rollupExpenseMonthRowsByYear } from "../ccExpenseGastosAggregate";
import { expenseYearMonthlyAverages } from "../expenseYearMonthlyAverage";
import { chileTodayYmd } from "../calendarMonth";
import {
  flowChartGranularityFromMetricsPeriod,
  flowTableGranularity,
  formatFlowMoney,
  rollupChartPointsByYear,
} from "../flowsDisplay";
import { clipMonthsThenRollup, clipPointsToTimeRange, type TimeRange } from "../timeRange";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import { useCcExpenseCategoryLevel } from "../useCcExpenseCategoryLevel";
import { ccExpenseCategoriesAtLevel, ccExpenseCategorySlugAtLevel } from "../ccExpenseCategories";
import { useCcExpenseExcludedBigGroups } from "../useCcExpenseExcludedBigGroups";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "../ccExpenseLineBuckets";
import { chartCategorySlugsForFlowsExpenses } from "../expenseDepositLinks";
import { activeBigGroupSlugs, bigGroupsWithUsage } from "../ccExpenseBigGroupTotals";
import type { FlowCcExpenseMonthRow } from "../types";

/** Latest month (YYYY-MM) with any real spend in the given rows. */
/** Chart Período choices: Diario is not offered on this page. */
const EXPENSES_CHART_PERIODS = ["month", "year"] as const;

/** Rangos long enough for the per-year average line to read as a trend. */
const YEAR_AVERAGE_RANGES: ReadonlySet<TimeRange> = new Set(["3y", "5y", "10y", "total"]);

function latestRealSpendMonth(rows: readonly FlowCcExpenseMonthRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (row.gastos_real_mes_clp !== 0 && (latest == null || row.period_month > latest)) {
      latest = row.period_month;
    }
  }
  return latest;
}

/** Tarjeta de crédito (grupo Pasivos): líneas de estado de cuenta, todos los signos. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.expenses.chart", "month", "3y");
  // A stored Diario from before it was dropped reads as Mensual.
  const metricsPeriod: "month" | "year" = chartPrefs.period === "year" ? "year" : "month";
  const timeRange = chartPrefs.range;
  const chartControls = (
    <SurfaceControls
      period={metricsPeriod}
      onPeriodChange={chartPrefs.setPeriod}
      periodOptions={EXPENSES_CHART_PERIODS}
      range={chartPrefs.range}
      onRangeChange={chartPrefs.setRange}
    />
  );
  const chartGranularity = metricsPeriod;
  // The month-detail table owns its período (month/year) and always covers full history.
  const tablePrefs = useSurfacePrefs("flows.expenses.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    flowChartGranularityFromMetricsPeriod(tablePrefs.period)
  );
  const { data, error } = useFlowsExpenses();
  const { installmentMode, setInstallmentMode } = useCcInstallmentGastosMode();
  const { categoryLevel, setCategoryLevel } = useCcExpenseCategoryLevel();

  /** The chart's categories at the chosen level: at «Categorías» a subcategory folds into its parent. */
  const chartCategories = useMemo(
    () => ccExpenseCategoriesAtLevel(data?.categories ?? [], categoryLevel),
    [categoryLevel, data?.categories]
  );
  const chartLines = useMemo(() => {
    if (!data) return [];
    const slugAt = ccExpenseCategorySlugAtLevel(data.categories, categoryLevel);
    return data.lines.map((l) => {
      const slug = slugAt(l.category_slug);
      return slug === l.category_slug ? l : { ...l, category_slug: slug };
    });
  }, [categoryLevel, data]);
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const chartCategorySlugs = useMemo(
    () =>
      chartCategorySlugsForFlowsExpenses(
        chartCategories.map((c) => c.slug).filter((slug) => !CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(slug))
      ),
    [chartCategories]
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
      chartLines,
      chartCategorySlugs,
      installmentMode,
      undefined,
      displayUnit
    );
    const chartAgg = aggregateGastosFromLines(
      chartLines,
      chartCategorySlugs,
      installmentMode,
      excludedBigGroups,
      displayUnit
    );
    return {
      table: tableAgg,
      chart: chartAgg,
      total: tableAgg.total,
      total_real: tableAgg.total_real,
    };
  }, [chartCategorySlugs, chartLines, data, displayUnit, excludedBigGroups, installmentMode]);

  /**
   * Latest month (YYYY-MM) with any real spend in the CURRENT mode. Table rows beyond this are
   * dropped so the table doesn't show an empty future tail — installment cuota lines create
   * future month buckets that are $0 in Total mode; Cuotas mode keeps them (real gastos).
   */
  const latestNonEmptyMonth = useMemo(
    () => (view ? latestRealSpendMonth(view.table.by_month) : null),
    [view]
  );

  /**
   * Chart x-axis end month is mode-INDEPENDENT: Total mode keeps the split-mode tail (future
   * months that only carry projected cuotas — $0 buckets under Total) so toggling
   * Total ↔ Por cuota never shrinks the x-axis range.
   */
  const chartEndMonth = useMemo(() => {
    if (!data || installmentMode === "split") return latestNonEmptyMonth;
    const splitEnd = latestRealSpendMonth(
      aggregateGastosFromLines(data.lines, [], "split", undefined, displayUnit).by_month
    );
    return splitEnd != null && (latestNonEmptyMonth == null || splitEnd > latestNonEmptyMonth)
      ? splitEnd
      : latestNonEmptyMonth;
  }, [data, displayUnit, installmentMode, latestNonEmptyMonth]);

  const chartPoints = useMemo(() => {
    if (!view) return [];
    const monthly = view.chart.chart_monthly_by_category.filter(
      (p) => chartEndMonth == null || p.as_of_date.slice(0, 7) <= chartEndMonth
    );
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(monthly, chartGranularity, timeRange, (rows) =>
      rollupChartPointsByYear(rows, chartCategorySlugs)
    );
  }, [chartCategorySlugs, chartEndMonth, chartGranularity, view, timeRange]);

  /**
   * Per-year average of the chart's monthly total, over full history (the Rango only clips
   * where it is drawn). Monthly chart and long Rangos only.
   */
  const yearAverages = useMemo(() => {
    if (!view || chartGranularity !== "month" || !YEAR_AVERAGE_RANGES.has(timeRange)) return null;
    const monthly = view.chart.chart_monthly_by_category.filter(
      (p) => chartEndMonth == null || p.as_of_date.slice(0, 7) <= chartEndMonth
    );
    return expenseYearMonthlyAverages(monthly, chartCategorySlugs, chileTodayYmd().slice(0, 7));
  }, [chartCategorySlugs, chartEndMonth, chartGranularity, view, timeRange]);

  /** Unfiltered totals — stack order stays stable when big groups are excluded from display. */
  const chartSortPoints = useMemo(() => {
    if (!view) return [];
    const monthly = view.table.chart_monthly_by_category.filter(
      (p) => chartEndMonth == null || p.as_of_date.slice(0, 7) <= chartEndMonth
    );
    return clipMonthsThenRollup(
      monthly,
      chartGranularity === "year" ? "year" : "month",
      timeRange,
      (rows) => rollupChartPointsByYear(rows, chartCategorySlugs)
    );
  }, [chartCategorySlugs, chartEndMonth, chartGranularity, view, timeRange]);

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

  /**
   * "En el rango" companion follows the CHART's Rango (headline `view.total` stays full): the
   * months the chart keeps, so it matches the bars at month and year grain alike.
   */
  const rangeTotals = useMemo(() => {
    if (!view) return { total: 0, total_real: 0 };
    let total = 0;
    let total_real = 0;
    for (const r of clipPointsToTimeRange(view.table.by_month, timeRange)) {
      if (latestNonEmptyMonth != null && r.period_month > latestNonEmptyMonth) continue;
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
        <span className="label-inline">{t("expenses.creditCard.categoryLevelLabel")}</span>
        <label className="radio-pill">
          <input
            type="radio"
            name="cc-expense-category-level"
            checked={categoryLevel === "category"}
            onChange={() => setCategoryLevel("category")}
          />
          {t("expenses.creditCard.categoryLevelCategory")}
        </label>
        <label className="radio-pill">
          <input
            type="radio"
            name="cc-expense-category-level"
            checked={categoryLevel === "subcategory"}
            onChange={() => setCategoryLevel("subcategory")}
          />
          {t("expenses.creditCard.categoryLevelSubcategory")}
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
          categories={chartCategories}
          displayUnit={displayUnit}
          xAxisGranularity={chartGranularity}
          yearAverages={yearAverages}
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
      <GroupExpensesMonthTable
        rows={monthTableRows}
        lines={data.lines}
        categories={data.categories}
        bigGroups={data.big_groups ?? []}
        installmentMode={installmentMode}
        displayUnit={displayUnit}
        periodGranularity={tableGranularity}
      />

      <AdditionalCardsSection summary={data.additional_cards} displayUnit={displayUnit} />

      <CreditCardUnclassifiedExpensesTable
        lines={data.lines}
        categories={data.categories}
        bigGroups={data.big_groups ?? []}
      />

      <CreditCardDepositMatchedExpensesTable lines={data.lines} categories={data.categories} />
    </>
  );
}
