import { useMemo } from "react";
import { Link } from "react-router-dom";
import { FlowsOverviewChart } from "../charts/lazyCharts";
import { SurfaceControls } from "../ui/SurfaceControls";
import { loadableClass } from "../ui/Loadable";
import { flowChartGranularityFromMetricsPeriod, formatFlowMoney } from "../../flowsDisplay";
import { minAdaptiveUsdFractionDigits } from "../../format";
import { rollupFlowsOverviewRowsByYear, ZERO_FLOWS_OVERVIEW_TOTALS } from "../../flowsOverviewRows";
import { useTranslation } from "../../i18n";
import { useFlowsOverview } from "../../queries/hooks";
import type { DisplayUnit } from "../../queries/keys";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { clipMonthsThenRollup, timeRangeCutoffYmd, timeRangeToDays } from "../../timeRange";
import type { FlowsOverviewRow } from "../../types";
import { useCcInstallmentGastosMode } from "../../useCcInstallmentGastosMode";
import { DeltaMetricFlow } from "./DeltaMetricFlow";
import styles from "./DashboardFlowsSummary.module.css";

const ZERO_ROW: FlowsOverviewRow = { period_month: "", as_of_date: "", ...ZERO_FLOWS_OVERVIEW_TOTALS };

type SummaryLine = {
  id: string;
  labelKey: string;
  value: (row: FlowsOverviewRow) => number;
  /** Drawn as a signed ▲/▼ delta, like the cards' P/L. */
  delta: boolean;
  /** Opens a section: a divider above. */
  section?: boolean;
};

/**
 * The summary's lines (pre-tax deposits and what the cash change leaves unexplained stay on the
 * /flows page): what came in and went out, then where the savings went — deposits, the cards
 * (cash leaves when a card is paid) and the cash change — then the market's part and the change
 * in investments and net worth.
 */
const SUMMARY_LINES: readonly SummaryLine[] = [
  { id: "income", labelKey: "flows.overview.income", value: (r) => r.income, delta: false },
  { id: "expenses", labelKey: "flows.overview.expenses", value: (r) => r.expenses, delta: false },
  { id: "savings", labelKey: "flows.overview.savings", value: (r) => r.savings, delta: true, section: true },
  { id: "deposits", labelKey: "flows.overview.deposits", value: (r) => r.deposits, delta: false },
  {
    id: "cards",
    labelKey: "flows.overview.cardSpentMinusPaid",
    value: (r) => r.card_net,
    delta: true,
  },
  { id: "cash_change", labelKey: "flows.overview.cashChange", value: (r) => r.cash_change, delta: true },
  { id: "pl", labelKey: "flows.overview.pl", value: (r) => r.pl, delta: false, section: true },
  {
    id: "investments_change",
    labelKey: "flows.overview.investmentsChange",
    value: (r) => r.investments_change,
    delta: true,
  },
  { id: "net_worth_change", labelKey: "flows.overview.netWorthChange", value: (r) => r.net_worth_change, delta: true },
];

/**
 * Home dashboard flows section: the last closed month and the twelve closed months ending with it,
 * as the server states them (`closed` of `GET /api/flows/overview` — the month in progress would
 * read as a deficit until its salary lands), and the /flows overview chart with its own Período /
 * Rango. The client only picks rows, clips them to the Rango and rolls years up.
 */
export function DashboardFlowsSummary({ displayUnit }: { displayUnit: DisplayUnit }) {
  const { t } = useTranslation();
  const prefs = useSurfacePrefs("dashboard.flows", "month", "1y");
  const granularity = flowChartGranularityFromMetricsPeriod(prefs.period);
  const isDaily = granularity === "day";
  const { installmentMode } = useCcInstallmentGastosMode();
  const overview = useFlowsOverview(
    displayUnit,
    installmentMode,
    isDaily ? timeRangeToDays(prefs.range) : undefined
  );
  const data = overview.data;
  const loading = !data || overview.isPlaceholderData;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    let rows: readonly FlowsOverviewRow[];
    if (isDaily) {
      const cutoff = timeRangeCutoffYmd(prefs.range);
      const days = data.days ?? [];
      rows = cutoff ? days.filter((r) => r.as_of_date >= cutoff) : days;
    } else {
      rows = clipMonthsThenRollup(
        data.months,
        granularity === "year" ? "year" : "month",
        prefs.range,
        rollupFlowsOverviewRowsByYear
      );
    }
    return rows.map((r) => ({
      as_of_date: r.as_of_date,
      income: r.income,
      expenses: -r.expenses,
      deposits: r.deposits,
      pl: r.pl,
    }));
  }, [data, granularity, isDaily, prefs.range]);

  const periods = [
    { labelKey: "dashboard.flows.lastMonth", row: data?.closed.last_month ?? ZERO_ROW },
    { labelKey: "dashboard.flows.last12Months", row: data?.closed.last_12_months ?? ZERO_ROW },
  ] as const;

  return (
    <section className={styles.root}>
      <div className="chart-panel-title-row">
        <h2 style={{ margin: 0 }}>{t("dashboard.flows.title")}</h2>
        <Link to="/flows" className={styles.link}>
          {t("dashboard.flows.openFlows")}
        </Link>
      </div>
      <div className={loadableClass(loading, styles.summary)}>
        {periods.map(({ labelKey, row }) => (
          <div key={labelKey} className={styles.period}>
            <div className={styles.periodTitle}>{t(labelKey)}</div>
            <dl className={styles.lines}>
              {SUMMARY_LINES.map((line) => {
                const value = line.value(row);
                return (
                  <div key={line.id} className={line.section ? styles.lineSection : styles.line}>
                    <dt>{t(line.labelKey)}</dt>
                    <dd className={line.delta ? undefined : "mono"}>
                      {line.delta ? (
                        <DeltaMetricFlow
                          delta={value}
                          fractionDigits={
                            displayUnit === "usd"
                              ? minAdaptiveUsdFractionDigits(SUMMARY_LINES.filter((l) => l.delta).map((l) => l.value(row)))
                              : 0
                          }
                        />
                      ) : (
                        formatFlowMoney(value, displayUnit)
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
      <div className="chart-grid chart-grid--full-line">
        <FlowsOverviewChart
          title={t("flows.overview.chartTitle")}
          controls={
            <SurfaceControls
              period={prefs.period}
              onPeriodChange={prefs.setPeriod}
              range={prefs.range}
              onRangeChange={prefs.setRange}
            />
          }
          points={chartPoints}
          xAxisGranularity={granularity}
          displayUnit={displayUnit}
          loading={loading}
        />
      </div>
    </section>
  );
}
