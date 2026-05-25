import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useFlowsExpenses } from "../queries/hooks";
import { ExpensesByApartmentChart } from "../components/charts/ExpensesByApartmentChart";
import { Table } from "../components/ui/Table";
import type { DashboardChartGranularity } from "../dashboardTimeseriesYearly";
import { formatClp } from "../format";
import { expenseApartmentLabel, expenseKindLabel, useTranslation } from "../i18n";
import type { ExpenseApartmentSlug, FlowExpenseAccountBlock } from "../types";

const ACCOUNT_ORDER: ExpenseApartmentSlug[] = ["el_vergel", "lastarria", "suecia"];

function formatAmountCell(amount_clp: number): string {
  if (amount_clp <= 0) return "—";
  return formatClp(amount_clp);
}

/** Gastos de arriendo / departamento (`/flows/expenses/real_estate`). */
export function RealEstateExpensesPage() {
  const { t } = useTranslation();
  const { accountSlug } = useParams<{ accountSlug?: string }>();
  const [granularity, setGranularity] = useState<DashboardChartGranularity>("monthly");
  const { data, error } = useFlowsExpenses();
  const err = error instanceof Error ? error.message : error ? "Failed to load" : null;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    return granularity === "yearly" ? data.chart_yearly : data.chart_monthly;
  }, [data, granularity]);

  const accountFilter = useMemo((): ExpenseApartmentSlug[] | undefined => {
    if (accountSlug && ACCOUNT_ORDER.includes(accountSlug as ExpenseApartmentSlug)) {
      return [accountSlug as ExpenseApartmentSlug];
    }
    return ["lastarria", "suecia"];
  }, [accountSlug]);

  const sections = useMemo(() => {
    if (!data) return [];
    const block = data.by_group.real_estate;
    if (!block) return [];
    const accounts = ACCOUNT_ORDER.map((slug) => block.by_account[slug]).filter(
      (a): a is FlowExpenseAccountBlock => a != null
    );
    const filtered = accountSlug
      ? accounts.filter((a) => a.account_slug === accountSlug)
      : accounts;
    if (filtered.length === 0) return [];
    return [{ group: "real_estate" as const, accounts: filtered }];
  }, [data, accountSlug]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  const titleSuffix =
    accountSlug != null ? expenseApartmentLabel(accountSlug as ExpenseApartmentSlug) : null;

  return (
    <>
      <h2 className="flow-section-title">
        {t("sidebar.flowsExpensesRealEstate")}
        {titleSuffix ? ` — ${titleSuffix}` : ""}
      </h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        {t("expenses.realEstateIntro")}
      </p>

      <div className="chart-controls" style={{ marginBottom: "0.75rem" }}>
        <span className="label-inline">{t("expenses.chartGranularityLabel")}</span>
        <label className="radio-pill">
          <input
            type="radio"
            name="expenses-granularity"
            checked={granularity === "monthly"}
            onChange={() => setGranularity("monthly")}
          />
          {t("dashboard.monthly")}
        </label>
        <label className="radio-pill">
          <input
            type="radio"
            name="expenses-granularity"
            checked={granularity === "yearly"}
            onChange={() => setGranularity("yearly")}
          />
          {t("dashboard.yearly")}
        </label>
      </div>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <ExpensesByApartmentChart
          title={t("expenses.chartTitle")}
          points={chartPoints}
          xAxisGranularity={granularity === "yearly" ? "year" : "month"}
          accountFilter={accountFilter}
        />
      </div>

      {sections.map(({ group, accounts }) => {
        const groupBlock = data.by_group[group];
        return (
          <section key={group} style={{ marginBottom: "1.75rem" }}>
            <h3 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>
              {t(`expenses.groups.${group}`)}
              <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                {formatClp(groupBlock?.total_clp ?? 0)}
              </span>
            </h3>
            {accounts.map((acc) => (
              <div key={acc.account_slug} style={{ marginBottom: "1.25rem" }}>
                <h4 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>
                  {expenseApartmentLabel(acc.account_slug)}
                  <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                    {formatClp(acc.total_clp)}
                  </span>
                </h4>
                <Table
                  tableStyle={{ fontSize: "0.85rem" }}
                  header={
                    <thead>
                      <tr>
                        <th>{t("expenses.colDate")}</th>
                        <th>{t("expenses.colKind")}</th>
                        <th>{t("expenses.colAmount")}</th>
                        <th>{t("expenses.colDetail")}</th>
                      </tr>
                    </thead>
                  }
                >
                  {acc.rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        {t("expenses.emptyAccount")}
                      </td>
                    </tr>
                  ) : (
                    acc.rows.map((r, idx) => (
                      <tr key={`${r.spent_on}-${r.category}-${idx}`}>
                        <td className="mono">{r.spent_on}</td>
                        <td>{expenseKindLabel(r.category)}</td>
                        <td className="mono">{formatAmountCell(r.amount_clp)}</td>
                        <td className="muted" style={{ fontSize: "0.8rem" }}>
                          {r.note ?? "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </Table>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
