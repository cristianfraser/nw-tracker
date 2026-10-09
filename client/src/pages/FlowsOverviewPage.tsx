import { useMemo } from "react";
import { FlowsOverviewChart } from "../components/charts/FlowsOverviewChart";
import { PaginatedTable, useClientPagination } from "../components/ui/PaginatedTable";
import { Table } from "../components/ui/Table";
import { loadableClass } from "../components/ui/Loadable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import {
  aggregateFlowsOverview,
  aggregateFlowsOverviewByDay,
  flowsOverviewTotals,
  rollupFlowsOverviewRowsByYear,
} from "../flowsOverviewAggregate";
import {
  flowChartGranularityFromMetricsPeriod,
  flowPeriodLabel,
  flowTableGranularity,
  formatFlowMoney,
} from "../flowsDisplay";
import { clipMonthsThenRollup, timeRangeCutoffYmd, timeRangeToDays } from "../timeRange";
import { useTranslation } from "../i18n";
import {
  useFlowsExpenses,
  useFlowsExpensesGastos,
  useFlowsDeposits,
  useFlowsPl,
  useIncome,
} from "../queries/hooks";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";

const PAGE_SIZE = 12;

/** Flows master page (/flows): income line vs expenses/deposits stacked bars + month detail. */
const NO_EXCLUDED_BIG_GROUPS: readonly string[] = [];

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

  const income = useIncome();
  const expenses = useFlowsExpenses();
  const gastos = useFlowsExpensesGastos(displayUnit, NO_EXCLUDED_BIG_GROUPS);
  const deposits = useFlowsDeposits();
  // Day mode needs the server's per-day bucket P/L for the overview's P/L leg.
  const pl = useFlowsPl(isDaily ? timeRangeToDays(timeRange) : undefined);

  const error = income.error ?? expenses.error ?? gastos.error ?? deposits.error ?? pl.error;
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  // Any of the five still pending (or holding a prior window/unit): the page renders its frame
  // with zero totals and no rows, dimmed.
  const loading =
    !income.data ||
    !expenses.data ||
    !gastos.data ||
    !deposits.data ||
    !pl.data ||
    gastos.isPlaceholderData ||
    pl.isPlaceholderData;

  const monthRows = useMemo(() => {
    if (!income.data || !expenses.data || !gastos.data || !deposits.data || !pl.data) return null;
    // Gasto del mes is level-independent: either category level's view carries the same months.
    const gastosView = gastos.data.views[`${installmentMode}|subcategory`];
    if (gastosView == null) throw new Error(`missing gastos view ${installmentMode}|subcategory`);
    return aggregateFlowsOverview(
      income.data,
      { lines: expenses.data.lines, gastos_by_month: gastosView.by_month },
      deposits.data,
      pl.data,
      installmentMode,
      displayUnit
    );
  }, [deposits.data, displayUnit, expenses.data, gastos.data, income.data, installmentMode, pl.data]);

  /** Day composite (Diario chart only); the detail table below stays month/year. */
  const dayRows = useMemo(() => {
    if (!isDaily || !income.data || !expenses.data || !deposits.data || !pl.data) return null;
    return aggregateFlowsOverviewByDay(
      income.data,
      expenses.data,
      deposits.data,
      (displayUnit === "usd" ? pl.data.chart_daily_usd : pl.data.chart_daily) ?? [],
      installmentMode,
      displayUnit
    );
  }, [deposits.data, displayUnit, expenses.data, income.data, installmentMode, isDaily, pl.data]);

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
  const fullTotals = useMemo(() => flowsOverviewTotals(monthRows ?? []), [monthRows]);
  const rangeTotals = useMemo(() => flowsOverviewTotals(chartRows), [chartRows]);

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
        <h3 style={{ fontSize: "1.05rem", margin: 0 }}>{t("flows.overview.detailTitle")}</h3>
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
        <span className="mono" style={{ color: "var(--text)" }}>
          {t("flows.overview.income")} {formatFlowMoney(fullTotals.income, displayUnit)}
        </span>
        {" · "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {t("flows.overview.expenses")} {formatFlowMoney(fullTotals.expenses, displayUnit)}
        </span>
        {" · "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {t("flows.overview.deposits")} {formatFlowMoney(fullTotals.deposits, displayUnit)}
        </span>
        {" · "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {t("flows.overview.depositsPreTax")} {formatFlowMoney(fullTotals.deposits_pre_tax, displayUnit)}
        </span>
        {" · "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {t("flows.overview.pl")} {formatFlowMoney(fullTotals.pl, displayUnit)}
        </span>
        {" · "}
        <span className="mono" style={{ color: "var(--text)" }}>
          {t("flows.overview.net")} {formatFlowMoney(fullTotals.net, displayUnit)}
        </span>
      </p>
      {timeRange !== "total" ? (
        <p className={loadableClass(loading, "muted")} style={{ marginBottom: "0.75rem", fontSize: "0.8rem" }}>
          {t("flows.rangeTotalLabel")}:{" "}
          <span className="mono">
            {t("flows.overview.income")} {formatFlowMoney(rangeTotals.income, displayUnit)}
          </span>
          {" · "}
          <span className="mono">
            {t("flows.overview.expenses")} {formatFlowMoney(rangeTotals.expenses, displayUnit)}
          </span>
          {" · "}
          <span className="mono">
            {t("flows.overview.deposits")} {formatFlowMoney(rangeTotals.deposits, displayUnit)}
          </span>
          {" · "}
          <span className="mono">
            {t("flows.overview.pl")} {formatFlowMoney(rangeTotals.pl, displayUnit)}
          </span>
          {" · "}
          <span className="mono">
            {t("flows.overview.net")} {formatFlowMoney(rangeTotals.net, displayUnit)}
          </span>
        </p>
      ) : null}

      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} loading={loading}>
        <Table
          header={
            <thead>
              <tr>
                <th>{t("flows.overview.colMonth")}</th>
                <th>{t("flows.overview.income")}</th>
                <th>{t("flows.overview.expenses")}</th>
                <th>{t("flows.overview.deposits")}</th>
                <th>{t("flows.overview.depositsPreTax")}</th>
                <th>{t("flows.overview.pl")}</th>
                <th>{t("flows.overview.net")}</th>
              </tr>
            </thead>
          }
          tableStyle={{ fontSize: "0.85rem" }}
        >
          {pageRows.map((row) => (
            <tr key={row.period_month}>
              <td className="mono">{flowPeriodLabel(row.period_month, tableGranularity)}</td>
              <td className="mono">{formatFlowMoney(row.income, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.expenses, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.deposits, displayUnit)}</td>
              <td className="mono muted">{formatFlowMoney(row.deposits_pre_tax, displayUnit)}</td>
              <td className="mono muted">{formatFlowMoney(row.pl, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.net, displayUnit)}</td>
            </tr>
          ))}
        </Table>
      </PaginatedTable>
    </>
  );
}
