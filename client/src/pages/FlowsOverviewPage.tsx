import { useMemo } from "react";
import { FlowsOverviewChart } from "../components/charts/FlowsOverviewChart";
import { PaginatedTable, useClientPagination } from "../components/ui/PaginatedTable";
import { Table } from "../components/ui/Table";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { loadableClass } from "../components/ui/Loadable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { flowsOverviewRangeTotals, rollupFlowsOverviewRowsByYear, ZERO_FLOWS_OVERVIEW_TOTALS } from "../flowsOverviewRows";
import {
  flowChartGranularityFromMetricsPeriod,
  flowPeriodLabel,
  flowTableGranularity,
  formatFlowMoney,
} from "../flowsDisplay";
import { clipMonthsThenRollup, timeRangeCutoffYmd, timeRangeToDays } from "../timeRange";
import { useTranslation } from "../i18n";
import { useFlowsOverview } from "../queries/hooks";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import type { FlowsOverviewTotals } from "../types";

const PAGE_SIZE = 12;

/**
 * Flows master page (/flows): income line vs expenses/deposits stacked bars + month detail. The
 * rows come from the server (`GET /api/flows/overview`); the page clips them to the chart's Rango
 * and rolls years up.
 */
/** One figure of the totals lines and the detail table, desktop column and mobile card alike. */
type OverviewColumn = {
  id: string;
  /** Header and mobile-card label. */
  labelKey: string;
  /** Totals-line label (the header's long form). */
  totalsLabelKey: string;
  value: (r: FlowsOverviewTotals) => number;
  muted?: boolean;
};

const COLUMNS: readonly OverviewColumn[] = [
  { id: "income", labelKey: "flows.overview.income", totalsLabelKey: "flows.overview.income", value: (r) => r.income },
  { id: "expenses", labelKey: "flows.overview.expenses", totalsLabelKey: "flows.overview.expenses", value: (r) => r.expenses },
  { id: "savings", labelKey: "flows.overview.savings", totalsLabelKey: "flows.overview.savings", value: (r) => r.savings },
  { id: "deposits", labelKey: "flows.overview.deposits", totalsLabelKey: "flows.overview.deposits", value: (r) => r.deposits },
  {
    id: "deposits_pre_tax",
    labelKey: "flows.overview.depositsPreTaxShort",
    totalsLabelKey: "flows.overview.depositsPreTax",
    value: (r) => r.deposits_pre_tax,
    muted: true,
  },
  {
    id: "cards",
    labelKey: "flows.overview.cardSpentMinusPaidShort",
    totalsLabelKey: "flows.overview.cardSpentMinusPaid",
    value: (r) => r.card_net,
  },
  { id: "cash_change", labelKey: "flows.overview.cashChange", totalsLabelKey: "flows.overview.cashChange", value: (r) => r.cash_change },
  {
    id: "cash_unexplained",
    labelKey: "flows.overview.cashUnexplained",
    totalsLabelKey: "flows.overview.cashUnexplained",
    value: (r) => r.cash_unexplained,
    muted: true,
  },
  { id: "pl", labelKey: "flows.overview.pl", totalsLabelKey: "flows.overview.pl", value: (r) => r.pl, muted: true },
  {
    id: "investments_change",
    labelKey: "flows.overview.investmentsChangeShort",
    totalsLabelKey: "flows.overview.investmentsChange",
    value: (r) => r.investments_change,
  },
  {
    id: "net_worth_change",
    labelKey: "flows.overview.netWorthChangeShort",
    totalsLabelKey: "flows.overview.netWorthChange",
    value: (r) => r.net_worth_change,
  },
];

export function FlowsOverviewPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.overview.chart", "month", "3y");
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
  const isDaily = chartGranularity === "day";
  // The detail table owns its período (month/year — the chart is the day surface) and
  // always covers full history.
  const tablePrefs = useSurfacePrefs("flows.overview.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    flowChartGranularityFromMetricsPeriod(tablePrefs.period)
  );
  const { installmentMode } = useCcInstallmentGastosMode();

  // Day mode asks for the day rows of the chart's window too.
  const overview = useFlowsOverview(
    displayUnit,
    installmentMode,
    isDaily ? timeRangeToDays(timeRange) : undefined
  );
  const err =
    overview.error instanceof Error
      ? overview.error.message
      : overview.error
        ? t("common.loadFailed")
        : null;
  // Pending (or holding a prior mode/window): the page renders its frame with zero totals and
  // no rows, dimmed.
  const loading = !overview.data || overview.isPlaceholderData;
  const monthRows = overview.data?.months ?? null;
  /** Day rows (Diario chart only); the detail table below stays month/year. */
  const dayRows = isDaily ? (overview.data?.days ?? null) : null;

  /** Chart rows (M/Y): months cut at the chart's Rango first, then rolled to its granularity. */
  const rows = useMemo(() => {
    if (!monthRows) return [];
    return clipMonthsThenRollup(
      monthRows,
      chartGranularity === "year" ? "year" : "month",
      timeRange,
      rollupFlowsOverviewRowsByYear
    );
  }, [chartGranularity, monthRows, timeRange]);

  /** What the chart plots: day rows in Diario (server-windowed P/L, client-clipped rest). */
  const chartRows = useMemo(() => {
    if (!isDaily) return rows;
    if (!dayRows) return [];
    const cutoff = timeRangeCutoffYmd(timeRange);
    return cutoff ? dayRows.filter((r) => r.as_of_date >= cutoff) : dayRows;
  }, [dayRows, isDaily, rows, timeRange]);

  const chartPoints = useMemo(
    () =>
      chartRows.map((r) => ({
        as_of_date: r.as_of_date,
        income: r.income,
        expenses: -r.expenses,
        deposits: r.deposits,
        pl: r.pl,
      })),
    [chartRows]
  );

  /** Headline totals stay full history; `rangeTotals` (shown when Rango ≠ Todo) follow the chart. */
  const fullTotals = overview.data?.totals ?? ZERO_FLOWS_OVERVIEW_TOTALS;
  const rangeTotals = useMemo(() => flowsOverviewRangeTotals(chartRows), [chartRows]);

  /** Table rows: FULL history (no range clip), rolled to the table's own período. */
  const tableRows = useMemo(() => {
    if (!monthRows) return [];
    const rolled =
      tableGranularity === "year" ? rollupFlowsOverviewRowsByYear(monthRows) : monthRows;
    return [...rolled].reverse();
  }, [monthRows, tableGranularity]);
  const { page, setPage, pageRows, total } = useClientPagination(tableRows, PAGE_SIZE);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.overview.title")}</h2>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <FlowsOverviewChart
          controls={chartControls}
          title={t("flows.overview.chartTitle")}
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
      <p
        className={loadableClass(loading, "muted")}
        style={{ marginBottom: timeRange !== "total" ? "0.35rem" : "0.75rem", fontSize: "0.85rem" }}
      >
        {t("flows.overview.totalsLabel")}{" "}
        {COLUMNS.map((c, i) => (
          <span key={c.id}>
            {i > 0 ? " · " : null}
            <span className="mono" style={{ color: "var(--text)" }}>
              {t(c.totalsLabelKey)} {formatFlowMoney(c.value(fullTotals), displayUnit)}
            </span>
          </span>
        ))}
      </p>
      {timeRange !== "total" ? (
        <p className={loadableClass(loading, "muted")} style={{ marginBottom: "0.75rem", fontSize: "0.8rem" }}>
          {t("flows.rangeTotalLabel")}:{" "}
          {COLUMNS.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? " · " : null}
              <span className="mono">
                {t(c.totalsLabelKey)} {formatFlowMoney(c.value(rangeTotals), displayUnit)}
              </span>
            </span>
          ))}
        </p>
      ) : null}

      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
        <Table
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("flows.overview.colMonth")}</th>
                {COLUMNS.map((c) => (
                  <th key={c.id} className="desktop-only">
                    {t(c.labelKey)}
                  </th>
                ))}
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
          tableClassName="table--parallel-mobile"
          tableStyle={{ fontSize: "0.85rem" }}
        >
          {pageRows.map((row) => {
            const period = flowPeriodLabel(row.period_month, tableGranularity);
            return (
              <tr key={row.period_month}>
                <td className="mono desktop-only">{period}</td>
                {COLUMNS.map((c) => (
                  <td key={c.id} className={c.muted ? "mono muted desktop-only" : "mono desktop-only"}>
                    {formatFlowMoney(c.value(row), displayUnit)}
                  </td>
                ))}
                <td className="mobile-only">
                  <TableMobileCard title={period}>
                    {COLUMNS.map((c) => (
                      <TableMobileCardRow
                        key={c.id}
                        label={t(c.labelKey)}
                        value={<span className="mono">{formatFlowMoney(c.value(row), displayUnit)}</span>}
                      />
                    ))}
                  </TableMobileCard>
                </td>
              </tr>
            );
          })}
        </Table>
      </PaginatedTable>
    </>
  );
}
