import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PageGridTile } from "../components/layout/PageGridTile";
import { FlowsPlChart } from "../components/charts/FlowsPlChart";
import { PaginatedTable, useClientPagination } from "../components/ui/PaginatedTable";
import { Table } from "../components/ui/Table";
import { ColumnTable, type TableColumn } from "../components/ui/ColumnTable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { loadableClass } from "../components/ui/Loadable";
import {
  flowTableGranularity,
  flowPeriodLabel,
  formatFlowMoney,
} from "../flowsDisplay";
import { clipMonthsThenRollup, timeRangeToDays } from "../timeRange";
import { rollupFlowsPlChartPointsByYear } from "../flowsPlAggregate";
import { flowsPlBucketLabel, useTranslation } from "../i18n";
import { useFlowsPl } from "../queries/hooks";
import type { FlowsPlBucketSlug } from "../types";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";

const PAGE_SIZE = 12;

/** The table's bucket columns, in the server's bucket order (`FLOWS_PL_BUCKETS`). */
const PL_TABLE_BUCKETS: FlowsPlBucketSlug[] = ["brokerage", "retirement", "cash", "real_estate"];

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
  const chartGranularity = metricsPeriod;
  // The detail table owns its período (month/year) and always covers full history.
  const tablePrefs = useSurfacePrefs("flows.pl.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    tablePrefs.period
  );
  const isDaily = chartGranularity === "day";
  // Day mode fetches the server-windowed per-day P/L; M/Y keep the days-less payload.
  const { data, error: queryError, isPending, isPlaceholderData } = useFlowsPl(
    displayUnit,
    isDaily ? timeRangeToDays(timeRange) : undefined
  );
  const error = queryLoadError({ data, error: queryError });
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  // Pending, or holding the prior Diario window while the new one loads: dimmed.
  const loading = queryShowsLoading({ isPending, isPlaceholderData });

  const chartPoints = useMemo(() => {
    if (!data) return [];
    if (chartGranularity === "day") {
      // Server already windows the daily series to `days`; no client clip.
      return data.chart_daily ?? [];
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      data.chart_monthly,
      chartGranularity,
      timeRange,
      rollupFlowsPlChartPointsByYear
    );
  }, [chartGranularity, data, timeRange]);

  /** Table rows: FULL history (no range clip), rolled to the table's own período. */
  const tableRows = useMemo(() => {
    if (!data) return [];
    const monthly = data.chart_monthly;
    const rows = tableGranularity === "year" ? rollupFlowsPlChartPointsByYear(monthly) : monthly;
    return [...rows].reverse();
  }, [data, tableGranularity]);
  const { page, setPage, pageRows, total } = useClientPagination(tableRows, PAGE_SIZE);

  type TableRow = (typeof pageRows)[number];
  const moneyColumn = (
    key: string,
    header: string,
    value: (row: TableRow) => number,
    muted = false
  ): TableColumn<TableRow> => ({
    key,
    header,
    className: muted ? "mono muted" : "mono",
    cardClassName: "mono",
    cell: (row) => formatFlowMoney(value(row), displayUnit),
  });
  const tableColumns: TableColumn<TableRow>[] = [
    {
      key: "period",
      header: t("flows.overview.colMonth"),
      className: "mono",
      cell: (row) => flowPeriodLabel(row.as_of_date, tableGranularity),
      title: true,
    },
    ...PL_TABLE_BUCKETS.map((slug) => moneyColumn(slug, flowsPlBucketLabel(slug), (row) => row[slug])),
    moneyColumn("total", t("flows.pl.colTotal"), (row) => row.total),
    moneyColumn("ytd", t("flows.pl.colYtd"), (row) => row.ytd_total, true),
    moneyColumn("cumulative", t("flows.pl.colCumulative"), (row) => row.cumulative_total, true),
  ];

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.pl.title")}</h2>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <FlowsPlChart
          controls={chartControls}
          title={t("flows.pl.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={displayUnit}
          loading={loading}
        />
      </div>

      <PageGridTile id="detail">
        <div className="chart-panel-title-row">
          <h3>{t("flows.overview.detailTitle")}</h3>
          <SurfaceControls
            period={tablePrefs.period}
            onPeriodChange={tablePrefs.setPeriod}
            periodOptions={["month", "year"]}
          />
        </div>
        <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
          <ColumnTable
            rows={pageRows}
            columns={tableColumns}
            rowKey={(row) => row.as_of_date}
            cardLayout="flat"
            tableStyle={{ fontSize: "var(--font-size-prose)" }}
          />
        </PaginatedTable>
      </PageGridTile>

      <PageGridTile id="breakdown" className="page-grid">
        <h3>
          {t("flows.pl.breakdownTitle")}
        </h3>
        {(data?.by_bucket ?? []).map((block) => (
          <PageGridTile key={block.slug} id={`pl-${block.slug}`}>
            <h4>
              {flowsPlBucketLabel(block.slug)}
              <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
                {formatFlowMoney(block.total_cumulative, displayUnit)}
              </span>
            </h4>
            <Table
              tableStyle={{ fontSize: "var(--font-size-prose)" }}
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
                    {formatFlowMoney(row.pl_month, displayUnit)}
                  </td>
                  <td className="mono">
                    {formatFlowMoney(row.pl_ytd, displayUnit)}
                  </td>
                  <td className="mono">
                    {formatFlowMoney(row.pl_cumulative, displayUnit)}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 600 }}>{t("flows.pl.totalsLabel")}</td>
                <td className="mono" style={{ fontWeight: 600 }}>
                  {formatFlowMoney(block.total_month, displayUnit)}
                </td>
                <td className="mono" style={{ fontWeight: 600 }}>
                  {formatFlowMoney(block.total_ytd, displayUnit)}
                </td>
                <td className="mono" style={{ fontWeight: 600 }}>
                  {formatFlowMoney(block.total_cumulative, displayUnit)}
                </td>
              </tr>
            </Table>
          </PageGridTile>
        ))}
      </PageGridTile>
    </>
  );
}
