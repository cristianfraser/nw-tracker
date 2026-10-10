import { useMemo, useState } from "react";
import { Button } from "@crfrsr/ui";
import { ManualExpenseDialog } from "../components/credit-card/ManualExpenseDialog";
import { useFlowsExpenses, useFlowsExpensesGastos } from "../queries/hooks";
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
import { loadableClass } from "../components/ui/Loadable";
import { useTranslation } from "../i18n";
import {
  flowChartGranularityFromMetricsPeriod,
  flowTableGranularity,
  formatFlowMoney,
  rollupChartPointsByYear,
} from "../flowsDisplay";
import { clipMonthsThenRollup, clipPointsToTimeRange, type TimeRange } from "../timeRange";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import { useCcExpenseCategoryLevel } from "../useCcExpenseCategoryLevel";
import { ccExpenseCategoriesAtLevel } from "../ccExpenseCategories";
import { useCcExpenseExcludedBigGroups } from "../useCcExpenseExcludedBigGroups";
import { activeBigGroupSlugs, bigGroupsWithUsage } from "../ccExpenseBigGroupTotals";

/** Chart Período choices: Diario is not offered on this page. */
const EXPENSES_CHART_PERIODS = ["month", "year"] as const;

/** Rangos long enough for the per-year average line to read as a trend. */
const YEAR_AVERAGE_RANGES: ReadonlySet<TimeRange> = new Set(["3y", "5y", "10y", "total"]);

/** Tarjeta de crédito (grupo Pasivos): líneas de estado de cuenta, todos los signos. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [manualOpen, setManualOpen] = useState(false);
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

  const activeBigGroups = useMemo(
    () => (data ? activeBigGroupSlugs(data.lines) : []),
    [data]
  );

  const { excludedBigGroups, isExcluded, toggleExcluded } =
    useCcExpenseExcludedBigGroups(activeBigGroups);
  const excludedBigGroupList = useMemo(() => [...excludedBigGroups], [excludedBigGroups]);
  // The default exclusion is every big group the lines carry: wait for them before asking.
  const gastos = useFlowsExpensesGastos(displayUnit, excludedBigGroupList, data != null);
  const loadError = error ?? gastos.error;
  const err =
    loadError instanceof Error ? loadError.message : loadError ? t("common.loadFailed") : null;

  const bigGroupUsage = useMemo(
    () =>
      data
        ? bigGroupsWithUsage(data.lines, data.big_groups ?? [], installmentMode)
        : [],
    [data, installmentMode]
  );

  /** The server's precomputed view for this installment mode and category level, in this unit. */
  const view = gastos.data?.views[`${installmentMode}|${categoryLevel}`] ?? null;

  const chartPoints = useMemo(() => {
    if (!view) return [];
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(view.chart_monthly_by_category, chartGranularity, timeRange, (rows) =>
      rollupChartPointsByYear(rows, view.chart_category_slugs)
    );
  }, [chartGranularity, view, timeRange]);

  /** Per-year averages (full history, server-built): monthly chart and long Rangos only. */
  const yearAverages =
    view && chartGranularity === "month" && YEAR_AVERAGE_RANGES.has(timeRange)
      ? view.year_averages
      : null;

  /** Unfiltered totals — stack order stays stable when big groups are excluded from display. */
  const chartSortPoints = useMemo(() => {
    if (!view) return [];
    return clipMonthsThenRollup(
      view.chart_sort_monthly_by_category ?? view.chart_monthly_by_category,
      chartGranularity === "year" ? "year" : "month",
      timeRange,
      (rows) => rollupChartPointsByYear(rows, view.chart_category_slugs)
    );
  }, [chartGranularity, view, timeRange]);

  /** Table rows: FULL history (no range clip), at the table's own período. */
  const monthTableRows = view ? (tableGranularity === "month" ? view.by_month : view.by_year) : [];

  /**
   * "En el rango" companion follows the CHART's Rango (headline `view.total` stays full): the
   * months the chart keeps, so it matches the bars at month and year grain alike.
   */
  const rangeTotals = useMemo(() => {
    if (!view) return { total: 0, total_real: 0 };
    let total = 0;
    let total_real = 0;
    for (const r of clipPointsToTimeRange(view.by_month, timeRange)) {
      total += r.gastos_mes_clp;
      total_real += r.gastos_real_mes_clp;
    }
    return { total, total_real };
  }, [view, timeRange]);

  const chartFilterActive = bigGroupUsage.some((g) => isExcluded(g.slug));

  // Two flags: the expense lines (sections below the table) and the gastos view (chart, month
  // table, totals), which waits for the lines and holds the prior view across an exclusion change.
  const linesLoading = !data;
  const gastosLoading = !data || !view || gastos.isPlaceholderData;

  if (err) {
    return <p className="error">{err}</p>;
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
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <Button variant="secondary" onClick={() => setManualOpen(true)}>
            {t("expenses.creditCard.manualExpense.add")}
          </Button>
          <CreditCardFacturadoFinancingManager lines={data?.lines ?? []} loading={linesLoading} />
        </span>
        <ManualExpenseDialog
          open={manualOpen}
          expense={null}
          categories={data?.categories ?? []}
          onClose={() => setManualOpen(false)}
        />
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
          loading={gastosLoading}
        />
      </div>
      {chartFilterActive ? (
        <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "1.5rem" }}>
          {t("expenses.creditCard.bigGroups.chartFilterHint")}
        </p>
      ) : null}

      <BigExpenseGroupsSection
        lines={data?.lines ?? []}
        categories={data?.categories ?? []}
        bigGroups={data?.big_groups ?? []}
        installmentMode={installmentMode}
        isExcluded={isExcluded}
        toggleExcluded={toggleExcluded}
        loading={linesLoading}
      />

      <div className="chart-panel-title-row" style={{ marginBottom: "0.5rem" }}>
      <h3 style={{ fontSize: "1.1rem", margin: 0 }}>
        {t(
          tableGranularity === "year"
            ? "accountDetail.yearlyDetailTitle"
            : "accountDetail.monthlyDetailTitle"
        )}
        <span
          className={loadableClass(gastosLoading, "muted mono")}
          style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}
        >
          {formatFlowMoney(view?.total ?? 0, displayUnit)}
          {view && view.total_real !== view.total ? (
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
        lines={data?.lines ?? []}
        categories={data?.categories ?? []}
        bigGroups={data?.big_groups ?? []}
        installmentMode={installmentMode}
        displayUnit={displayUnit}
        periodGranularity={tableGranularity}
        loading={gastosLoading}
      />

      <AdditionalCardsSection
        summary={data?.additional_cards}
        displayUnit={displayUnit}
        loading={linesLoading}
      />

      <CreditCardUnclassifiedExpensesTable
        lines={data?.lines ?? []}
        categories={data?.categories ?? []}
        bigGroups={data?.big_groups ?? []}
        loading={linesLoading}
      />

      <CreditCardDepositMatchedExpensesTable
        lines={data?.lines ?? []}
        categories={data?.categories ?? []}
        loading={linesLoading}
      />
    </>
  );
}
