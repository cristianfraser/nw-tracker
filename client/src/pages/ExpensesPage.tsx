import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { ExpensesByApartmentChart } from "../components/ExpensesByApartmentChart";
import { Table } from "../components/Table";
import type { DashboardChartGranularity } from "../dashboardTimeseriesYearly";
import { formatClp } from "../format";
import { expenseApartmentLabel, expenseKindLabel, useTranslation } from "../i18n";
import type {
  ExpenseApartmentSlug,
  ExpenseFlowGroupSlug,
  FlowExpenseAccountBlock,
  FlowsExpensesResponse,
} from "../types";

const GROUP_ORDER: ExpenseFlowGroupSlug[] = ["real_estate"];
const ACCOUNT_ORDER: ExpenseApartmentSlug[] = ["el_vergel", "lastarria", "suecia"];

function formatAmountCell(amount_clp: number): string {
  if (amount_clp <= 0) return "—";
  return formatClp(amount_clp);
}

export function ExpensesPage() {
  const { t } = useTranslation();
  const { groupSlug, accountSlug } = useParams<{ groupSlug?: string; accountSlug?: string }>();
  const [data, setData] = useState<FlowsExpensesResponse | null>(null);
  const [granularity, setGranularity] = useState<DashboardChartGranularity>("monthly");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.flowsExpenses();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chartPoints = useMemo(() => {
    if (!data) return [];
    return granularity === "yearly" ? data.chart_yearly : data.chart_monthly;
  }, [data, granularity]);

  const accountFilter = useMemo((): ExpenseApartmentSlug[] | undefined => {
    if (accountSlug && ACCOUNT_ORDER.includes(accountSlug as ExpenseApartmentSlug)) {
      return [accountSlug as ExpenseApartmentSlug];
    }
    if (groupSlug === "real_estate") {
      return ["lastarria", "suecia"];
    }
    return undefined;
  }, [groupSlug, accountSlug]);

  const sections = useMemo(() => {
    if (!data) return [];
    const out: { group: ExpenseFlowGroupSlug; accounts: FlowExpenseAccountBlock[] }[] = [];
    for (const g of GROUP_ORDER) {
      if (groupSlug && groupSlug !== g) continue;
      const block = data.by_group[g];
      if (!block) continue;
      const accounts = ACCOUNT_ORDER.map((slug) => block.by_account[slug]).filter(
        (a): a is FlowExpenseAccountBlock => a != null
      );
      const filtered = accountSlug
        ? accounts.filter((a) => a.account_slug === accountSlug)
        : accounts;
      if (filtered.length > 0) out.push({ group: g, accounts: filtered });
    }
    return out;
  }, [data, groupSlug, accountSlug]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  const titleSuffix =
    accountSlug != null
      ? expenseApartmentLabel(accountSlug as ExpenseApartmentSlug)
      : groupSlug === "real_estate"
        ? t("expenses.groups.real_estate")
        : null;

  return (
    <>
      <h2 className="flow-section-title">
        {t("sidebar.flowsExpenses")}
        {titleSuffix ? ` — ${titleSuffix}` : ""}
      </h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.75rem" }}>
        Gastos de arriendo y departamento desde{" "}
        <span className="mono">cfraser/depto-Table 1-2.csv</span>. Lastarria es arriendo (no suma al
        patrimonio inmobiliario); Suecia es tu depto en cartera.
      </p>

      <div className="chart-controls" style={{ marginBottom: "0.75rem" }}>
        <span className="label-inline">Gráfico</span>
        <label className="radio-pill">
          <input
            type="radio"
            name="expenses-granularity"
            checked={granularity === "monthly"}
            onChange={() => setGranularity("monthly")}
          />
          Mensual
        </label>
        <label className="radio-pill">
          <input
            type="radio"
            name="expenses-granularity"
            checked={granularity === "yearly"}
            onChange={() => setGranularity("yearly")}
          />
          Anual
        </label>
      </div>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack" style={{ marginBottom: "1.5rem" }}>
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
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th>Monto</th>
                        <th>Detalle</th>
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
