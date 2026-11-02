import { useMemo } from "react";
import { Link } from "react-router-dom";
import { FlowsOverviewChart } from "../charts/lazyCharts";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder, dashboardTileWide } from "../../dashboardLayout";
import { SurfaceControls } from "../ui/SurfaceControls";
import { loadableClass } from "../ui/Loadable";
import { flowChartGranularityFromMetricsPeriod, formatFlowMoney } from "../../flowsDisplay";
import { minAdaptiveUsdFractionDigits } from "../../format";
import { rollupFlowsOverviewRowsByYear, ZERO_FLOWS_OVERVIEW_TOTALS } from "../../flowsOverviewRows";
import { useTranslation } from "../../i18n";
import { useFlowsOverview } from "../../queries/hooks";
import type { DisplayUnit } from "../../queries/keys";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { clipMonthsThenRollup, clipPointsToTimeRange, timeRangeToDays } from "../../timeRange";
import type { FlowsOverviewRow } from "../../types";
import { useCcInstallmentGastosMode } from "../../useCcInstallmentGastosMode";
import { DeltaMetricFlow } from "./DeltaMetricFlow";
import styles from "./DashboardFlowsSummary.module.css";
import type { ComponentType } from "react";
import type { IconProps } from "../icons/iconProps";
import { BanknoteIcon } from "../icons/BanknoteIcon";
import { CashChangeIcon } from "../icons/CashChangeIcon";
import { CoinsIcon } from "../icons/CoinsIcon";
import { CreditCardIcon } from "../icons/CreditCardIcon";
import { DeltaIcon } from "../icons/DeltaIcon";
import { NetWorthUpIcon } from "../icons/NetWorthUpIcon";
import { PiggyBankIcon } from "../icons/PiggyBankIcon";
import { ShoppingBagIcon } from "../icons/ShoppingBagIcon";
import { TrendingUpIcon } from "../icons/TrendingUpIcon";

const ZERO_ROW: FlowsOverviewRow = { period_month: "", as_of_date: "", ...ZERO_FLOWS_OVERVIEW_TOTALS };

type SummaryLine = {
  id: string;
  labelKey: string;
  /** Stands for the label on the line; the label stays as its title (hover) and for screen readers. */
  icon: ComponentType<IconProps>;
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
  { id: "income", icon: BanknoteIcon, labelKey: "flows.overview.income", value: (r) => r.income, delta: false },
  { id: "expenses", icon: ShoppingBagIcon, labelKey: "flows.overview.expenses", value: (r) => r.expenses, delta: false },
  { id: "savings", icon: PiggyBankIcon, labelKey: "flows.overview.savings", value: (r) => r.savings, delta: true, section: true },
  { id: "deposits", icon: CoinsIcon, labelKey: "flows.overview.deposits", value: (r) => r.deposits, delta: false },
  {
    id: "cards",
    icon: CreditCardIcon,
    labelKey: "flows.overview.cardSpentMinusPaid",
    value: (r) => r.card_net,
    delta: true,
  },
  { id: "cash_change", icon: CashChangeIcon, labelKey: "flows.overview.cashChange", value: (r) => r.cash_change, delta: true },
  { id: "pl", icon: DeltaIcon, labelKey: "flows.overview.pl", value: (r) => r.pl, delta: false, section: true },
  {
    id: "investments_change",
    icon: TrendingUpIcon,
    labelKey: "flows.overview.investmentsChange",
    value: (r) => r.investments_change,
    delta: true,
  },
  { id: "net_worth_change", icon: NetWorthUpIcon, labelKey: "flows.overview.netWorthChange", value: (r) => r.net_worth_change, delta: true },
];

/**
 * Home dashboard «Flujos» summary: the last closed month and the twelve closed months ending
 * with it, as the server states them (`closed` of `GET /api/flows/overview` — the month in
 * progress would read as a deficit until its salary lands). Two cards of a 4-up `.cards` block,
 * so they take the same quarter width and dividers as the strip cards; its own tile, so the
 * big-desktop rail can hold it apart from the chart (`DashboardFlowsChart`). Both halves read the
 * same react-query entry (the month payload, no `days`).
 */
export function DashboardFlowsPeriods({ displayUnit }: { displayUnit: DisplayUnit }) {
  const { t } = useTranslation();
  const { installmentMode } = useCcInstallmentGastosMode();
  const overview = useFlowsOverview(displayUnit, installmentMode, undefined);
  const data = overview.data;
  const loading = !data || overview.isPlaceholderData;

  const periods = [
    { labelKey: "dashboard.flows.lastMonth", row: data?.closed.last_month ?? ZERO_ROW },
    { labelKey: "dashboard.flows.last12Months", row: data?.closed.last_12_months ?? ZERO_ROW },
  ] as const;

  return (
    <PageGridTile id="flows-periods" order={dashboardTileOrder("flows-periods")}>
      <h2>
        <Link to="/flows">{t("dashboard.flows.title")}</Link>
      </h2>
      <div className={loadableClass(loading, "cards", styles.periods)}>
        {periods.map(({ labelKey, row }) => (
          <div key={labelKey} className={`card ${styles.period}`}>
            <div className={styles.periodTitle}>{t(labelKey)}</div>
            <dl className={styles.lines}>
              {SUMMARY_LINES.map((line) => {
                const value = line.value(row);
                return (
                  <div key={line.id} className={line.section ? styles.lineSection : styles.line}>
                    <dt title={t(line.labelKey)}>
                      <line.icon size={18} strokeWidth={2.25} className={styles.icon} />
                      <span className="visually-hidden">{t(line.labelKey)}</span>
                    </dt>
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
    </PageGridTile>
  );
}

/**
 * The /flows overview chart on the home dashboard, with its own Período / Rango
 * (`dashboard.flows`). The client only picks rows, clips them to the Rango and rolls years up.
 */
export function DashboardFlowsChart({ displayUnit }: { displayUnit: DisplayUnit }) {
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
      rows = clipPointsToTimeRange(data.days ?? [], prefs.range);
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

  return (
    <PageGridTile
      id="flows-chart"
      order={dashboardTileOrder("flows-chart")}
      wide={dashboardTileWide("flows-chart")}
      className="chart-grid chart-grid--full-line"
    >
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
    </PageGridTile>
  );
}
