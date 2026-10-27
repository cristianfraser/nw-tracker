import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useFlowsDeposits } from "../queries/hooks";
import { DepositsByCategoryChart } from "../components/charts/DepositsByCategoryChart";
import { Table } from "../components/ui/Table";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { loadableClass } from "../components/ui/Loadable";
import { useTranslation, depositFlowCategoryLabel } from "../i18n";
import {
  flowChartGranularityFromMetricsPeriod,
  formatFlowMoney,
  sumChartPointsField,
} from "../flowsDisplay";
import { clipMonthsThenRollup, clipPointsToTimeRange } from "../timeRange";
import {
  aggregateDepositChartPointsByDay,
  rollupDepositChartPointsByYear,
} from "../flowsDepositsAggregate";
import type { DepositFlowCategory } from "../types";

const CATEGORY_ORDER: DepositFlowCategory[] = ["real_estate", "cash", "brokerage", "inversiones"];

export function DepositsPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.deposits.chart", "month", "3y");
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
  const { data, error } = useFlowsDeposits();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  // The frame renders with a zero total and empty category tables until the payload arrives.
  const loading = !data;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    if (chartGranularity === "day") {
      return clipPointsToTimeRange(
        aggregateDepositChartPointsByDay(data.rows, displayUnit),
        timeRange
      );
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      displayUnit === "usd" ? data.chart_monthly_usd : data.chart_monthly,
      chartGranularity,
      timeRange,
      rollupDepositChartPointsByYear
    );
  }, [chartGranularity, data, displayUnit, timeRange]);

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
  /** The total's two parts, as the flows overview reads them: post-tax deposits and AFP/AFC. */
  const postTaxTotal = data ? (displayUnit === "usd" ? data.post_tax_total_usd : data.post_tax_total_clp) : 0;
  const preTaxTotal = data ? (displayUnit === "usd" ? data.pre_tax_total_usd : data.pre_tax_total_clp) : 0;

  /** "En el rango" companion: sum of the clipped chart points (matches the visible bars). */
  const rangeTotal = useMemo(
    () => sumChartPointsField(chartPoints, "total"),
    [chartPoints]
  );


  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsDeposits")}</h2>
      <p style={{ marginBottom: "0.75rem", fontSize: "0.85rem" }}>
        <Link to="reconciliation">{t("depositsReconciliation.title")}</Link>
      </p>

      <p className={loadableClass(loading, "muted")} style={{ marginBottom: "1rem" }}>
        {t("deposits.totalLabel")}{" "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {formatFlowMoney(total, displayUnit)}
        </span>
        <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
          ({t("flows.overview.deposits")}{" "}
          <span className="mono">{formatFlowMoney(postTaxTotal, displayUnit)}</span>
          {" · "}
          {t("flows.overview.depositsPreTax")}{" "}
          <span className="mono">{formatFlowMoney(preTaxTotal, displayUnit)}</span>)
        </span>
        {timeRange !== "total" ? (
          <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
            · {t("flows.rangeTotalLabel")}{" "}
            <span className="mono">{formatFlowMoney(rangeTotal, displayUnit)}</span>
          </span>
        ) : null}
      </p>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack" style={{ marginBottom: "1.5rem" }}>
        <DepositsByCategoryChart
          controls={chartControls}
          title={t("deposits.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
          loading={loading}
        />
      </div>

      {CATEGORY_ORDER.map((cat) => {
        // Tables include full history (the chart's Rango only scopes the chart + its
        // companion total); the section subtotal equals the server subtotal.
        const blockRows = data ? data.by_category[cat].rows : [];
        const blockTotal = blockRows.reduce(
          (s, r) => s + (displayUnit === "usd" ? r.amount_usd ?? 0 : r.amount_clp),
          0
        );
        return (
          <section key={cat} style={{ marginBottom: "1.5rem" }}>
            <h3 style={{ marginBottom: "0.35rem" }}>
              {depositFlowCategoryLabel(cat)}
              <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                {formatFlowMoney(blockTotal, displayUnit)}
              </span>
            </h3>
            <Table
              tableStyle={{ fontSize: "0.85rem" }}
              collapsedVisibleRows={15}
              showMoreLabel={t("notifications.showMore")}
              showLessLabel={t("table.showLess")}
              wrapClassName={loadableClass(loading)}
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
              {blockRows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {t("deposits.emptyCategory")}
                  </td>
                </tr>
              ) : (
                blockRows.map((r, idx) => {
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
                        {r.mortgage_carrying ? (
                          <span className="muted" style={{ marginLeft: "0.4rem", fontSize: "0.8rem" }}>
                            {t("deposits.mortgageCarryingTag")}
                          </span>
                        ) : null}
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
