import { useFlowsCreditCardExpenses } from "../queries/hooks";
import { CreditCardGroupExpensesChart } from "../components/CreditCardGroupExpensesChart";
import { CreditCardGroupExpensesMonthTable } from "../components/CreditCardGroupExpensesMonthTable";
import { CreditCardUnclassifiedExpensesTable } from "../components/CreditCardUnclassifiedExpensesTable";
import { formatClp } from "../format";
import { useTranslation } from "../i18n";

/** Tarjeta de crédito (grupo Pasivos): líneas de estado de cuenta, todos los signos. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { data, error } = useFlowsCreditCardExpenses();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsExpenses")}</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        {t("expenses.creditCard.intro")}
      </p>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <CreditCardGroupExpensesChart
          title={t("expenses.creditCard.chartTitle")}
          points={data.chart_monthly_by_category}
          categories={data.categories}
        />
      </div>

      <h3 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
        {t("accountDetail.monthlyDetailTitle")}
        <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
          {formatClp(data.total_clp)}
          {data.total_real_clp !== data.total_clp ? (
            <>
              {" · "}
              {t("expenses.creditCard.colMonthExpenseReal")}: {formatClp(data.total_real_clp)}
            </>
          ) : null}
        </span>
      </h3>
      <p className="muted" style={{ fontSize: "var(--font-size-ui)", marginBottom: "0.5rem" }}>
        {t("expenses.creditCard.monthlyDetailHint")}
      </p>
      <CreditCardGroupExpensesMonthTable
        rows={data.by_month}
        lines={data.lines}
        categories={data.categories}
      />

      <CreditCardUnclassifiedExpensesTable lines={data.lines} categories={data.categories} />
    </>
  );
}
