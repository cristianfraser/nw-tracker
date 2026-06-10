import { useMemo } from "react";
import { useFlowsCreditCardExpenses } from "../queries/hooks";
import { CreditCardGroupExpensesChart } from "../components/charts/CreditCardGroupExpensesChart";
import { GroupExpensesMonthTable } from "../components/credit-card/GroupExpensesMonthTable";
import { BigExpenseGroupsSection } from "../components/credit-card/BigExpenseGroupsSection";
import { CreditCardUnclassifiedExpensesTable } from "../components/credit-card/CreditCardUnclassifiedExpensesTable";
import { CreditCardDepositMatchedExpensesTable } from "../components/credit-card/CreditCardDepositMatchedExpensesTable";
import { formatClp } from "../format";
import { useTranslation } from "../i18n";
import { aggregateGastosFromLines, computeExpensesTotalClp } from "../ccExpenseGastosAggregate";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import { useCcExpenseExcludedBigGroups } from "../useCcExpenseExcludedBigGroups";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "../ccExpenseLineBuckets";
import { activeBigGroupSlugs, bigGroupsWithUsage } from "../ccExpenseBigGroupTotals";

/** Tarjeta de crédito (grupo Pasivos): líneas de estado de cuenta, todos los signos. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { data, error } = useFlowsCreditCardExpenses();
  const { installmentMode, setInstallmentMode } = useCcInstallmentGastosMode();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const chartCategorySlugs = useMemo(
    () =>
      (data?.categories ?? [])
        .map((c) => c.slug)
        .filter((slug) => !CC_EXPENSE_TOTALS_EXCLUDED_SLUGS.has(slug)),
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
    const tableAgg = aggregateGastosFromLines(data.lines, chartCategorySlugs, installmentMode);
    const chartAgg = aggregateGastosFromLines(
      data.lines,
      chartCategorySlugs,
      installmentMode,
      excludedBigGroups
    );
    const totals = computeExpensesTotalClp(data.lines, installmentMode);
    return { table: tableAgg, chart: chartAgg, ...totals };
  }, [chartCategorySlugs, data, excludedBigGroups, installmentMode]);

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
      </div>

      {bigGroupUsage.length > 0 ? (
        <div
          className="chart-controls"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            gap: "0.35rem 1rem",
            marginBottom: "1rem",
          }}
        >
          <span className="label-inline">{t("expenses.creditCard.bigGroups.chartFilterLabel")}</span>
          {bigGroupUsage.map((g) => (
            <label key={g.slug} className="radio-pill" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={isExcluded(g.slug)}
                onChange={() => toggleExcluded(g.slug)}
              />
              {g.label}
              <span className="mono muted" style={{ marginLeft: "0.35rem", fontSize: "0.85em" }}>
                {formatClp(g.total_clp)}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: chartFilterActive ? "0.35rem" : "1.5rem" }}
      >
        <CreditCardGroupExpensesChart
          title={t("expenses.creditCard.chartTitle")}
          points={view.chart.chart_monthly_by_category}
          categories={data.categories}
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
      />

      <h3 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
        {t("accountDetail.monthlyDetailTitle")}
        <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
          {formatClp(view.total_clp)}
          {view.total_real_clp !== view.total_clp ? (
            <>
              {" · "}
              {t("expenses.creditCard.colMonthExpenseReal")}: {formatClp(view.total_real_clp)}
            </>
          ) : null}
        </span>
      </h3>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("expenses.creditCard.monthlyDetailHint")}
      </p>
      <GroupExpensesMonthTable
        rows={view.table.by_month}
        lines={data.lines}
        categories={data.categories}
        bigGroups={data.big_groups ?? []}
        installmentMode={installmentMode}
      />

      <CreditCardUnclassifiedExpensesTable lines={data.lines} categories={data.categories} />

      <CreditCardDepositMatchedExpensesTable lines={data.lines} categories={data.categories} />
    </>
  );
}
