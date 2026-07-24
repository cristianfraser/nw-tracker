import { useMemo } from "react";
import { FlowsOverviewChart } from "../components/charts/FlowsOverviewChart";
import { PaginatedTable, useClientPagination } from "../components/ui/PaginatedTable";
import { Table } from "../components/ui/Table";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  aggregateFlowsOverview,
  flowsOverviewTotals,
  rollupFlowsOverviewRowsByYear,
} from "../flowsOverviewAggregate";
import {
  flowChartGranularityFromMetricsPeriod,
  flowPeriodLabel,
  flowTableGranularity,
  formatFlowMoney,
} from "../flowsDisplay";
import { timeRangeCutoffYmd } from "../timeRange";
import { useTranslation } from "../i18n";
import { useFlowsCreditCardExpenses, useFlowsDeposits, useFlowsPl, useIncome } from "../queries/hooks";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";

const PAGE_SIZE = 12;

/** Flows master page (/flows): income line vs expenses/deposits stacked bars + month detail. */
export function FlowsOverviewPage() {
  const { t } = useTranslation();
  const { displayUnit, metricsPeriod, timeRange } = useDisplayPreferences();
  const chartGranularity = flowChartGranularityFromMetricsPeriod(metricsPeriod);
  // Day mode falls back to the monthly chart/table here for now (Overview composes four feeds;
  // the day composite is the remaining Phase B work). Rango still applies.
  const displayGranularity = flowTableGranularity(chartGranularity);
  const { installmentMode } = useCcInstallmentGastosMode();

  const income = useIncome();
  const expenses = useFlowsCreditCardExpenses();
  const deposits = useFlowsDeposits();
  const pl = useFlowsPl();

  const error = income.error ?? expenses.error ?? deposits.error ?? pl.error;
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const monthRows = useMemo(() => {
    if (!income.data || !expenses.data || !deposits.data || !pl.data) return null;
    return aggregateFlowsOverview(
      income.data,
      expenses.data,
      deposits.data,
      pl.data,
      installmentMode,
      displayUnit
    );
  }, [deposits.data, displayUnit, expenses.data, income.data, installmentMode, pl.data]);

  const rows = useMemo(() => {
    if (!monthRows) return [];
    const cutoff = timeRangeCutoffYmd(timeRange);
    const clipped = cutoff ? monthRows.filter((r) => r.as_of_date >= cutoff) : monthRows;
    return chartGranularity === "year" ? rollupFlowsOverviewRowsByYear(clipped) : clipped;
  }, [chartGranularity, monthRows, timeRange]);

  const chartPoints = useMemo(
    () =>
      rows.map((r) => ({
        as_of_date: r.as_of_date,
        income: r.income,
        expenses: -r.expenses,
        deposits: r.deposits,
        pl: r.pl,
      })),
    [rows]
  );

  /** Headline totals stay full history; `rangeTotals` (shown when Rango ≠ Todo) follow the clip. */
  const fullTotals = useMemo(
    () => (monthRows ? flowsOverviewTotals(monthRows) : null),
    [monthRows]
  );
  const rangeTotals = useMemo(() => flowsOverviewTotals(rows), [rows]);

  const tableRows = useMemo(() => [...rows].reverse(), [rows]);
  const { page, setPage, pageRows, total } = useClientPagination(tableRows, PAGE_SIZE);

  if (err) {
    return <p className="error">{err}</p>;
  }

  if (!monthRows || !fullTotals) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.overview.title")}</h2>
      <p className="muted" style={{ maxWidth: "52rem", marginBottom: "1rem" }}>
        {t("flows.overview.intro")}
      </p>

      <div
        className="chart-grid chart-grid--full-line chart-grid--full-width-stack"
        style={{ marginBottom: "1.5rem" }}
      >
        <FlowsOverviewChart
          title={t("flows.overview.chartTitle")}
          points={chartPoints}
          xAxisGranularity={displayGranularity}
          displayUnit={displayUnit}
        />
      </div>

      <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>
        {t("flows.overview.detailTitle")}
      </h3>
      <p className="muted" style={{ marginBottom: timeRange !== "total" ? "0.35rem" : "0.75rem", fontSize: "0.85rem" }}>
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
        <p className="muted" style={{ marginBottom: "0.75rem", fontSize: "0.8rem" }}>
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

      <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
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
              <td className="mono">{flowPeriodLabel(row.period_month, displayGranularity)}</td>
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
