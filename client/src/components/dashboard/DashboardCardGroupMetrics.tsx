import { cn } from "../../cn";
import {
  roundedMetricDelta,
  roundedMetricDeposits,
  type CardGroupMetricsByPeriod,
  type CardGroupMetricsPeriod,
} from "../../dashboardCardBreakdown";
import { accountingCurrencyNumberFlowParts, minAdaptiveUsdFractionDigits } from "../../format";
import { useTranslation } from "../../i18n";
import { AnimatedNumberFlow } from "./AnimatedNumberFlow";
import { DashboardCardsValueGroup } from "./DashboardCardValue";
import { DeltaMetricFlow } from "./DeltaMetricFlow";
import styles from "./CardGroupMetrics.module.css";

const METRIC_MOUNT_DIGIT_RANGE: [number, number] = [5, 7];
const METRIC_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const METRIC_TIMING = {
  transformTiming: { duration: 320, easing: METRIC_EASING },
  spinTiming: { duration: 320, easing: METRIC_EASING },
};

type Props = {
  /** All three period slices; every card renders día/mes/año rows simultaneously. */
  metricsByPeriod: CardGroupMetricsByPeriod;
  showUsd: boolean;
  cardSlug: string;
  animated?: boolean;
  placeholderPhase?: boolean;
};

const PERIOD_ROWS: readonly {
  period: CardGroupMetricsPeriod;
  labelKey: string;
  depositsKey: string;
  deltaKey: string;
}[] = [
  {
    period: "day",
    labelKey: "dashboard.cardBreakdown.rowDay",
    depositsKey: "dashboard.cardBreakdown.periodDepositsDay",
    deltaKey: "dashboard.cardBreakdown.periodDeltaDay",
  },
  {
    period: "month",
    labelKey: "dashboard.cardBreakdown.rowMonth",
    depositsKey: "dashboard.cardBreakdown.periodDepositsMonth",
    deltaKey: "dashboard.cardBreakdown.periodDeltaMonth",
  },
  {
    period: "year",
    labelKey: "dashboard.cardBreakdown.rowYear",
    depositsKey: "dashboard.cardBreakdown.periodDepositsYear",
    deltaKey: "dashboard.cardBreakdown.periodDeltaYear",
  },
];

function DepositedMetricFlow({
  value,
  showUsd,
  animated,
  placeholderPhase,
  mountSeedId,
}: {
  value: number | null;
  showUsd: boolean;
  animated: boolean;
  placeholderPhase: boolean;
  mountSeedId: string;
}) {
  if (value == null) {
    return <span className={cn(styles.amount, styles.amountEmpty, "mono")}>—</span>;
  }
  const unit = showUsd ? "usd" : "clp";
  return (
    <AnimatedNumberFlow
      value={value}
      animated={animated}
      placeholderPhase={placeholderPhase}
      mountSeedDigitRange={METRIC_MOUNT_DIGIT_RANGE}
      mountSeedId={mountSeedId}
      mapDisplayValue={(n) => accountingCurrencyNumberFlowParts(n, unit, "$")}
      className={cn(styles.amount, "mono")}
      transformTiming={METRIC_TIMING.transformTiming}
      spinTiming={METRIC_TIMING.spinTiming}
    />
  );
}

/** One [label | deposits | Δ] grid row (cells are direct grid items of `.root`). */
function MetricsRow({
  label,
  deposited,
  depositedLabel,
  delta,
  deltaLabel,
  deltaFractionDigits,
  showUsd,
  animated,
  placeholderPhase,
  cardSlug,
  rowKey,
}: {
  label: string;
  deposited: number | null;
  depositedLabel: string;
  delta: number | null;
  deltaLabel: string;
  deltaFractionDigits: number;
  showUsd: boolean;
  animated: boolean;
  placeholderPhase: boolean;
  cardSlug: string;
  rowKey: string;
}) {
  return (
    <>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.deposited} title={depositedLabel}>
        <span className="visually-hidden">{depositedLabel}</span>
        <DepositedMetricFlow
          value={deposited}
          showUsd={showUsd}
          animated={animated}
          placeholderPhase={placeholderPhase}
          mountSeedId={`${cardSlug}:deposited:${rowKey}`}
        />
      </span>
      <span className={styles.deltaWrap} title={deltaLabel}>
        <DeltaMetricFlow
          delta={delta}
          animated={animated}
          placeholderPhase={placeholderPhase}
          mountSeedId={`${cardSlug}:delta:${rowKey}`}
          fractionDigits={deltaFractionDigits}
        />
      </span>
    </>
  );
}

export function DashboardCardGroupMetrics({
  metricsByPeriod,
  showUsd,
  cardSlug,
  animated = true,
  placeholderPhase = false,
}: Props) {
  const { t } = useTranslation();

  // Lifetime fields are identical across slices — read them from the month slice.
  const lifetime = metricsByPeriod.month;
  const totalDeposited = roundedMetricDeposits(lifetime, showUsd, "total");
  const totalDelta = roundedMetricDelta(lifetime, showUsd, "total");
  const periodRows = PERIOD_ROWS.map((row) => ({
    ...row,
    deposited: roundedMetricDeposits(metricsByPeriod[row.period], showUsd, "period"),
    delta: roundedMetricDelta(metricsByPeriod[row.period], showUsd, "period"),
  }));
  // All USD deltas of the card share the least adaptive decimals of the set.
  const deltaFractionDigits = showUsd
    ? minAdaptiveUsdFractionDigits([totalDelta, ...periodRows.map((r) => r.delta)])
    : 0;

  return (
    <div className={styles.root} aria-label={t("dashboard.cardBreakdown.summaryAria")}>
      <DashboardCardsValueGroup>
        <MetricsRow
          label={t("dashboard.cardBreakdown.rowTotal")}
          deposited={totalDeposited}
          depositedLabel={t("dashboard.cardBreakdown.totalDeposited")}
          delta={totalDelta}
          deltaLabel={t("dashboard.cardBreakdown.totalDelta")}
          deltaFractionDigits={deltaFractionDigits}
          showUsd={showUsd}
          animated={animated}
          placeholderPhase={placeholderPhase}
          cardSlug={cardSlug}
          rowKey="total"
        />
        <span className={styles.divider} aria-hidden="true" />
        {periodRows.map((row) => (
          <MetricsRow
            key={row.period}
            label={t(row.labelKey)}
            deposited={row.deposited}
            depositedLabel={t(row.depositsKey)}
            delta={row.delta}
            deltaLabel={t(row.deltaKey)}
            deltaFractionDigits={deltaFractionDigits}
            showUsd={showUsd}
            animated={animated}
            placeholderPhase={placeholderPhase}
            cardSlug={cardSlug}
            rowKey={row.period}
          />
        ))}
      </DashboardCardsValueGroup>
    </div>
  );
}
