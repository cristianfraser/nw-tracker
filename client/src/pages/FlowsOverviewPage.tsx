import { useMemo } from "react";
import { FlowsOverviewChart } from "../components/charts/FlowsOverviewChart";
import { PageGridTile } from "../components/layout/PageGridTile";
import { FlowsOverviewPeriodList } from "../components/flows/FlowsOverviewPeriodList";
import { loadableClass } from "../components/ui/Loadable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { flowsOverviewRangeTotals, rollupFlowsOverviewRowsByYear, ZERO_FLOWS_OVERVIEW_TOTALS } from "../flowsOverviewRows";
import { flowTableGranularity, formatFlowMoney } from "../flowsDisplay";
import { clipMonthsThenRollup, clipPointsToTimeRange, timeRangeToDays } from "../timeRange";
import { useTranslation } from "../i18n";
import { useHeldFlowsOverview } from "../queries/hooks";
import { useCcInstallmentGastosMode } from "../useCcInstallmentGastosMode";
import type { FlowsOverviewTotals } from "../types";

/** The net-worth change's parts, as the server derives it (`derivedFlowsOverviewFields`). */
const NET_WORTH_PARTS: readonly { labelKey: string; value: (r: FlowsOverviewTotals) => number }[] = [
  { labelKey: "flows.overview.savings", value: (r) => r.savings },
  { labelKey: "flows.overview.contributionsOutsidePayslip", value: (r) => r.contributions_outside_payslip },
  { labelKey: "flows.overview.pl", value: (r) => r.pl },
  { labelKey: "flows.overview.cashFx", value: (r) => r.cash_fx },
];

/**
 * Flows master page (/flows): the all-time net-worth change, income line vs expenses/deposits
 * stacked bars, and the period list. The rows come from the server (`GET /api/flows/overview`);
 * the page clips them to the chart's Rango and rolls years up.
 */
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
  const chartGranularity = metricsPeriod;
  const isDaily = chartGranularity === "day";
  // The period list owns its período (month/year — the chart is the day surface) and
  // always covers full history.
  const tablePrefs = useSurfacePrefs("flows.overview.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    tablePrefs.period
  );
  const { installmentMode } = useCcInstallmentGastosMode();

  // Day mode asks for the day rows of the chart's window too. Held across a unit, mode or window
  // change (dimmed, in its own unit: everything below formats with `unit`).
  const overview = useHeldFlowsOverview(
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
  // Pending with nothing to show: the frame with zero totals and no rows, dimmed; a held payload
  // shows dimmed.
  const loading = !overview.data || overview.loading;
  const unit = overview.data?.unit ?? displayUnit;
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
    return clipPointsToTimeRange(dayRows, timeRange);
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

  /** Headline totals stay full history; `rangeTotals` (shown when Rango ≠ Todo) follow the chart. The
   * zero totals only while there is nothing to show. */
  const fullTotals = overview.data?.totals ?? ZERO_FLOWS_OVERVIEW_TOTALS;
  const rangeTotals = useMemo(() => flowsOverviewRangeTotals(chartRows), [chartRows]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.overview.title")}</h2>

      <p className={loadableClass(loading, "muted")}>
        {t("flows.overview.summaryLabel")}{" "}
        <span className="mono flow-summary-value">
          {formatFlowMoney(fullTotals.net_worth_change, unit)}
        </span>
        <span className="muted flow-summary-note">
          (
          {NET_WORTH_PARTS.map((part, i) => (
            <span key={part.labelKey}>
              {i > 0 ? " · " : null}
              {t(part.labelKey)} <span className="mono">{formatFlowMoney(part.value(fullTotals), unit)}</span>
            </span>
          ))}
          )
        </span>
        {timeRange !== "total" ? (
          <span className="muted flow-summary-note">
            · {t("flows.rangeTotalLabel")}{" "}
            <span className="mono">{formatFlowMoney(rangeTotals.net_worth_change, unit)}</span>
          </span>
        ) : null}
      </p>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <FlowsOverviewChart
          controls={chartControls}
          title={t("flows.overview.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={unit}
          loading={loading}
        />
      </div>

      <PageGridTile id="detail">
        <div className="chart-panel-title-row">
          <h3>{t(tableGranularity === "year" ? "flows.overview.sectionYearly" : "flows.overview.sectionMonthly")}</h3>
          {/* The basis: the Expenses page totals by the day each expense was spent. */}
          <span className="muted">{t("flows.overview.expensesBasis")}</span>
          <SurfaceControls
            period={tablePrefs.period}
            onPeriodChange={tablePrefs.setPeriod}
            periodOptions={["month", "year"]}
          />
        </div>
        {/* Keyed by grain: the open rows and the page are the month view's or the year view's. */}
        <FlowsOverviewPeriodList
          key={tableGranularity}
          months={monthRows}
          granularity={tableGranularity}
          displayUnit={unit}
          loading={loading}
        />
      </PageGridTile>
    </>
  );
}
