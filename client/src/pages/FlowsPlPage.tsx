import { useMemo } from "react";
import { Link } from "react-router-dom";
import { FlowsPlChart } from "../components/charts/FlowsPlChart";
import { PaginatedTable, useClientPagination } from "../components/ui/PaginatedTable";
import { Table } from "../components/ui/Table";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  flowChartGranularityFromMetricsPeriod,
  flowPeriodLabel,
  formatFlowMoney,
} from "../flowsDisplay";
import { clipPointsToTimeRange } from "../timeRange";
import { flowsPlBucketLabel, useTranslation } from "../i18n";
import { useFlowsPl } from "../queries/hooks";
import type { FlowsPlAccountRow, FlowsPlBucketBlock } from "../types";

const PAGE_SIZE = 12;

function accountRowValue(
  row: FlowsPlAccountRow,
  field: "pl_month" | "pl_ytd" | "pl_cumulative",
  unit: "clp" | "usd"
): number {
  return row[`${field}_${unit}`];
}

function bucketTotal(
  block: FlowsPlBucketBlock,
  field: "total_month" | "total_ytd" | "total_cumulative",
  unit: "clp" | "usd"
): number {
  return block[`${field}_${unit}`];
}

/** Flows → PL: monthly market P/L of the money buckets (brokerage / retiro / efectivo). */
export function FlowsPlPage() {
  const { t } = useTranslation();
  const { displayUnit, metricsPeriod, timeRange } = useDisplayPreferences();
  const chartGranularity = flowChartGranularityFromMetricsPeriod(metricsPeriod);
  const { data, error } = useFlowsPl();
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    const base =
      displayUnit === "usd"
        ? chartGranularity === "year"
          ? data.chart_yearly_usd
          : data.chart_monthly_usd
        : chartGranularity === "year"
          ? data.chart_yearly
          : data.chart_monthly;
    return clipPointsToTimeRange(base, timeRange);
  }, [chartGranularity, data, displayUnit, timeRange]);

  const tableRows = useMemo(() => [...chartPoints].reverse(), [chartPoints]);
  const { page, setPage, pageRows, total } = useClientPagination(tableRows, PAGE_SIZE);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!data) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.pl.title")}</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "1rem" }}>
        {t("flows.pl.intro")}
      </p>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <FlowsPlChart
          title={t("flows.pl.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
        />
      </div>

      <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
        {t("flows.overview.detailTitle")}
      </h3>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
        <Table
          header={
            <thead>
              <tr>
                <th>{t("flows.overview.colMonth")}</th>
                <th>{flowsPlBucketLabel("brokerage")}</th>
                <th>{flowsPlBucketLabel("retirement")}</th>
                <th>{flowsPlBucketLabel("cash")}</th>
                <th>{t("flows.pl.colTotal")}</th>
                <th>{t("flows.pl.colYtd")}</th>
                <th>{t("flows.pl.colCumulative")}</th>
              </tr>
            </thead>
          }
          tableStyle={{ fontSize: "0.85rem" }}
        >
          {pageRows.map((row) => (
            <tr key={row.as_of_date}>
              <td className="mono">
                {flowPeriodLabel(row.as_of_date.slice(0, 7), chartGranularity)}
              </td>
              <td className="mono">{formatFlowMoney(row.brokerage, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.retirement, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.cash, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.total, displayUnit)}</td>
              <td className="mono muted">{formatFlowMoney(row.ytd_total, displayUnit)}</td>
              <td className="mono muted">{formatFlowMoney(row.cumulative_total, displayUnit)}</td>
            </tr>
          ))}
        </Table>
      </PaginatedTable>

      <h3 style={{ fontSize: "1.05rem", margin: "1.5rem 0 0.35rem" }}>
        {t("flows.pl.breakdownTitle")}
      </h3>
      {data.by_bucket.map((block) => (
        <section key={block.slug} style={{ marginBottom: "1.5rem" }}>
          <h4 style={{ fontSize: "0.95rem", marginBottom: "0.35rem" }}>
            {flowsPlBucketLabel(block.slug)}
            <span className="muted mono" style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
              {formatFlowMoney(bucketTotal(block, "total_cumulative", displayUnit), displayUnit)}
            </span>
          </h4>
          <Table
            tableStyle={{ fontSize: "0.85rem" }}
            header={
              <thead>
                <tr>
                  <th>{t("flows.pl.colAccount")}</th>
                  <th>{t("flows.pl.colMonthPl")}</th>
                  <th>{t("flows.pl.colYtd")}</th>
                  <th>{t("flows.pl.colCumulative")}</th>
                </tr>
              </thead>
            }
          >
            {block.accounts.map((row) => (
              <tr key={row.account_id}>
                <td>
                  <Link to={`/account/${row.account_id}`}>{row.name}</Link>
                </td>
                <td className="mono">
                  {formatFlowMoney(accountRowValue(row, "pl_month", displayUnit), displayUnit)}
                </td>
                <td className="mono">
                  {formatFlowMoney(accountRowValue(row, "pl_ytd", displayUnit), displayUnit)}
                </td>
                <td className="mono">
                  {formatFlowMoney(accountRowValue(row, "pl_cumulative", displayUnit), displayUnit)}
                </td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 600 }}>{t("flows.pl.totalsLabel")}</td>
              <td className="mono" style={{ fontWeight: 600 }}>
                {formatFlowMoney(bucketTotal(block, "total_month", displayUnit), displayUnit)}
              </td>
              <td className="mono" style={{ fontWeight: 600 }}>
                {formatFlowMoney(bucketTotal(block, "total_ytd", displayUnit), displayUnit)}
              </td>
              <td className="mono" style={{ fontWeight: 600 }}>
                {formatFlowMoney(bucketTotal(block, "total_cumulative", displayUnit), displayUnit)}
              </td>
            </tr>
          </Table>
        </section>
      ))}
    </>
  );
}
