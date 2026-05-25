import { useMemo } from "react";
import { useFlowsCreditCardExpenses } from "../queries/hooks";
import { CreditCardGroupExpensesChart } from "../components/charts/CreditCardGroupExpensesChart";
import { CreditCardGroupExpensesMonthTable } from "../components/credit-card/CreditCardGroupExpensesMonthTable";
import { CreditCardUnclassifiedExpensesTable } from "../components/credit-card/CreditCardUnclassifiedExpensesTable";
import { formatClp } from "../format";
import { useTranslation } from "../i18n";
import { aggregateGastosFromLines, computeExpensesTotalClp } from "../ccExpenseGastosAggregate";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import { CC_EXPENSE_TOTALS_EXCLUDED_SLUGS } from "../ccExpenseLineBuckets";

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

  const view = useMemo(() => {
    if (!data) return null;
    // Chart and table must use the same lines + installment mode (server by_month is split-only).
    const agg = aggregateGastosFromLines(data.lines, chartCategorySlugs, installmentMode);
    const totals = computeExpensesTotalClp(data.lines, installmentMode);
    return { ...agg, ...totals };
  }, [chartCategorySlugs, data, installmentMode]);

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

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <CreditCardGroupExpensesChart
          title={t("expenses.creditCard.chartTitle")}
          points={view.chart_monthly_by_category}
          categories={data.categories}
        />
      </div>

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
      <CreditCardGroupExpensesMonthTable
        rows={view.by_month}
        lines={data.lines}
        categories={data.categories}
        installmentMode={installmentMode}
      />

      <CreditCardUnclassifiedExpensesTable lines={data.lines} categories={data.categories} />
    </>
  );
}
