import { useMemo } from "react";
import { Link } from "react-router-dom";
import { FlowsPlChart } from "../components/charts/FlowsPlChart";
import { PaginatedTable, useClientPagination } from "../components/ui/PaginatedTable";
import { Table } from "../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { loadableClass } from "../components/ui/Loadable";
import {
  flowChartGranularityFromMetricsPeriod,
  flowTableGranularity,
  flowPeriodLabel,
  formatFlowMoney,
} from "../flowsDisplay";
import { clipMonthsThenRollup, timeRangeToDays } from "../timeRange";
import { rollupFlowsPlChartPointsByYear } from "../flowsPlAggregate";
import { flowsPlBucketLabel, useTranslation } from "../i18n";
import { useFlowsPl } from "../queries/hooks";
import type { FlowsPlAccountRow, FlowsPlBucketBlock, FlowsPlBucketSlug } from "../types";

const PAGE_SIZE = 12;

/** The table's bucket columns, in the server's bucket order (`FLOWS_PL_BUCKETS`). */
const PL_TABLE_BUCKETS: FlowsPlBucketSlug[] = ["brokerage", "retirement", "cash", "real_estate"];

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

/** Flows → PL: monthly market P/L of the buckets (brokerage / retiro / efectivo / inmuebles) — the flows overview's P/L. */
export function FlowsPlPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.pl.chart", "month", "3y");
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
  // The detail table owns its período (month/year) and always covers full history.
  const tablePrefs = useSurfacePrefs("flows.pl.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    flowChartGranularityFromMetricsPeriod(tablePrefs.period)
  );
  const isDaily = chartGranularity === "day";
  // Day mode fetches the server-windowed per-day P/L; M/Y keep the days-less payload.
  const { data, error, isPending, isPlaceholderData } = useFlowsPl(
    isDaily ? timeRangeToDays(timeRange) : undefined
  );
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  // Pending, or holding the prior Diario window while the new one loads: dimmed.
  const loading = isPending || isPlaceholderData;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    if (chartGranularity === "day") {
      // Server already windows the daily series to `days`; no client clip.
      return (displayUnit === "usd" ? data.chart_daily_usd : data.chart_daily) ?? [];
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      displayUnit === "usd" ? data.chart_monthly_usd : data.chart_monthly,
      chartGranularity,
      timeRange,
      rollupFlowsPlChartPointsByYear
    );
  }, [chartGranularity, data, displayUnit, timeRange]);

  /** Table rows: FULL history (no range clip), rolled to the table's own período. */
  const tableRows = useMemo(() => {
    if (!data) return [];
    const monthly = displayUnit === "usd" ? data.chart_monthly_usd : data.chart_monthly;
    const rows = tableGranularity === "year" ? rollupFlowsPlChartPointsByYear(monthly) : monthly;
    return [...rows].reverse();
  }, [data, displayUnit, tableGranularity]);
  const { page, setPage, pageRows, total } = useClientPagination(tableRows, PAGE_SIZE);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.pl.title")}</h2>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <FlowsPlChart
          controls={chartControls}
          title={t("flows.pl.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
          loading={loading}
        />
      </div>

      <div className="chart-panel-title-row">
        <h3 style={{ margin: 0 }}>{t("flows.overview.detailTitle")}</h3>
        <SurfaceControls
          period={tablePrefs.period}
          onPeriodChange={tablePrefs.setPeriod}
          periodOptions={["month", "year"]}
        />
      </div>
      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
        <Table
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("flows.overview.colMonth")}</th>
                {PL_TABLE_BUCKETS.map((slug) => (
                  <th key={slug} className="desktop-only">
                    {flowsPlBucketLabel(slug)}
                  </th>
                ))}
                <th className="desktop-only">{t("flows.pl.colTotal")}</th>
                <th className="desktop-only">{t("flows.pl.colYtd")}</th>
                <th className="desktop-only">{t("flows.pl.colCumulative")}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
          tableClassName="table--parallel-mobile"
          tableStyle={{ fontSize: "0.85rem" }}
        >
          {pageRows.map((row) => {
            const period = flowPeriodLabel(row.as_of_date, tableGranularity);
            return (
              <tr key={row.as_of_date}>
                <td className="mono desktop-only">{period}</td>
                {PL_TABLE_BUCKETS.map((slug) => (
                  <td key={slug} className="mono desktop-only">
                    {formatFlowMoney(row[slug], displayUnit)}
                  </td>
                ))}
                <td className="mono desktop-only">{formatFlowMoney(row.total, displayUnit)}</td>
                <td className="mono muted desktop-only">{formatFlowMoney(row.ytd_total, displayUnit)}</td>
                <td className="mono muted desktop-only">{formatFlowMoney(row.cumulative_total, displayUnit)}</td>
                <td className="mobile-only">
                  <TableMobileCard title={period}>
                    {PL_TABLE_BUCKETS.map((slug) => (
                      <TableMobileCardRow
                        key={slug}
                        label={flowsPlBucketLabel(slug)}
                        value={<span className="mono">{formatFlowMoney(row[slug], displayUnit)}</span>}
                      />
                    ))}
                    <TableMobileCardRow
                      label={t("flows.pl.colTotal")}
                      value={<span className="mono">{formatFlowMoney(row.total, displayUnit)}</span>}
                    />
                    <TableMobileCardRow
                      label={t("flows.pl.colYtd")}
                      value={<span className="mono">{formatFlowMoney(row.ytd_total, displayUnit)}</span>}
                    />
                    <TableMobileCardRow
                      label={t("flows.pl.colCumulative")}
                      value={<span className="mono">{formatFlowMoney(row.cumulative_total, displayUnit)}</span>}
                    />
                  </TableMobileCard>
                </td>
              </tr>
            );
          })}
        </Table>
      </PaginatedTable>

      <h3 style={{ margin: "1.5rem 0 0.35rem" }}>
        {t("flows.pl.breakdownTitle")}
      </h3>
      {(data?.by_bucket ?? []).map((block) => (
        <section key={block.slug} style={{ marginBottom: "1.5rem" }}>
          <h4 style={{ marginBottom: "0.35rem" }}>
            {flowsPlBucketLabel(block.slug)}
            <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "0.85rem", marginLeft: "0.5rem" }}>
              {formatFlowMoney(bucketTotal(block, "total_cumulative", displayUnit), displayUnit)}
            </span>
          </h4>
          <Table
            tableStyle={{ fontSize: "0.85rem" }}
            wrapClassName={loadableClass(loading)}
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
