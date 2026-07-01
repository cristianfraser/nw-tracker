import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useFlowsDeposits } from "../queries/hooks";
import { DepositsByCategoryChart } from "../components/charts/DepositsByCategoryChart";
import { Table } from "../components/ui/Table";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useTranslation, depositFlowCategoryLabel } from "../i18n";
import {
  flowChartGranularityFromMetricsPeriod,
  formatFlowMoney,
} from "../flowsDisplay";
import type { DepositFlowCategory } from "../types";

const CATEGORY_ORDER: DepositFlowCategory[] = ["real_estate", "cash", "brokerage", "inversiones"];

export function DepositsPage() {
  const { t } = useTranslation();
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const chartGranularity = flowChartGranularityFromMetricsPeriod(metricsPeriod);
  const { data, error } = useFlowsDeposits();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    if (displayUnit === "usd") {
      return chartGranularity === "year" ? data.chart_yearly_usd : data.chart_monthly_usd;
    }
    return chartGranularity === "year" ? data.chart_yearly : data.chart_monthly;
  }, [chartGranularity, data, displayUnit]);

  const total = useMemo(() => {
    if (!data) return 0;
    if (displayUnit === "usd") {
      if (data.net_total_usd == null) {
        throw new Error("missing net_total_usd for deposits in USD display");
      }
      return data.net_total_usd;
    }
    return data.net_total_clp;
  }, [data, displayUnit]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsDeposits")}</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "0.5rem" }}>
        {t("deposits.intro")}
      </p>
      <p style={{ marginBottom: "0.75rem", fontSize: "0.85rem" }}>
        <Link to="reconciliation">{t("depositsReconciliation.title")}</Link>
      </p>

      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("deposits.totalLabel")}{" "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {formatFlowMoney(total, displayUnit)}
        </span>
      </p>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack" style={{ marginBottom: "1.5rem" }}>
        <DepositsByCategoryChart
          title={t("deposits.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
        />
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const block = data.by_category[cat];
        const blockTotal =
          displayUnit === "usd"
            ? block.total_usd ?? 0
            : block.total_clp;
        return (
          <section key={cat} style={{ marginBottom: "1.5rem" }}>
            <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
              {depositFlowCategoryLabel(cat)}
              <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                {formatFlowMoney(blockTotal, displayUnit)}
              </span>
            </h3>
            <Table
              tableStyle={{ fontSize: "0.85rem" }}
              collapsedVisibleRows={15}
              showMoreLabel={t("notifications.showMore")}
              showLessLabel={t("table.showLess")}
              header={
                <thead>
                  <tr>
                    <th>{t("deposits.colDate")}</th>
                    <th>{t("deposits.colCategory")}</th>
                    <th>{t("deposits.colAccount")}</th>
                    <th>{t("deposits.colAmount")}</th>
                  </tr>
                </thead>
              }
            >
              {block.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {t("deposits.emptyCategory")}
                  </td>
                </tr>
              ) : (
                block.rows.map((r, idx) => {
                  const amount =
                    displayUnit === "usd"
                      ? r.amount_usd ?? 0
                      : r.amount_clp;
                  return (
                    <tr key={`${r.account_id}-${r.occurred_on}-${idx}`}>
                      <td className="mono">{r.occurred_on}</td>
                      <td>{depositFlowCategoryLabel(r.category)}</td>
                      <td>
                        <Link to={`/account/${r.account_id}`}>{r.account_name}</Link>
                      </td>
                      <td className="mono">{formatFlowMoney(amount, displayUnit)}</td>
                    </tr>
                  );
                })
              )}
            </Table>
          </section>
        );
      })}
    </>
  );
}
