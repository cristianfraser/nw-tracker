import { cn } from "../../cn";
import {
  roundedMetricDelta,
  roundedMetricDeposits,
  type CardGroupMetrics,
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
  metrics: CardGroupMetrics;
  showUsd: boolean;
  period: CardGroupMetricsPeriod;
  cardSlug: string;
  animated?: boolean;
  placeholderPhase?: boolean;
};

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

function MetricsRow({
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
    <div className={styles.row}>
      <span className={styles.deposited}>
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
    </div>
  );
}

export function DashboardCardGroupMetrics({
  metrics,
  showUsd,
  period,
  cardSlug,
  animated = true,
  placeholderPhase = false,
}: Props) {
  const { t } = useTranslation();
  const periodDepositsLabel =
    period === "year"
      ? t("dashboard.cardBreakdown.periodDepositsYear")
      : period === "day"
        ? t("dashboard.cardBreakdown.periodDepositsDay")
        : t("dashboard.cardBreakdown.periodDepositsMonth");
  const periodDeltaLabel =
    period === "year"
      ? t("dashboard.cardBreakdown.periodDeltaYear")
      : period === "day"
        ? t("dashboard.cardBreakdown.periodDeltaDay")
        : t("dashboard.cardBreakdown.periodDeltaMonth");

  const totalDeposited = roundedMetricDeposits(metrics, showUsd, "total");
  const totalDelta = roundedMetricDelta(metrics, showUsd, "total");
  const periodDeposited = roundedMetricDeposits(metrics, showUsd, "period");
  const periodDelta = roundedMetricDelta(metrics, showUsd, "period");
  // Both USD deltas of the card share the least adaptive decimals of the pair.
  const deltaFractionDigits = showUsd
    ? minAdaptiveUsdFractionDigits([totalDelta, periodDelta])
    : 0;

  return (
    <div className={styles.root} aria-label={t("dashboard.cardBreakdown.summaryAria")}>
      <DashboardCardsValueGroup>
        <MetricsRow
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
        <MetricsRow
          deposited={periodDeposited}
          depositedLabel={periodDepositsLabel}
          delta={periodDelta}
          deltaLabel={periodDeltaLabel}
          deltaFractionDigits={deltaFractionDigits}
          showUsd={showUsd}
          animated={animated}
          placeholderPhase={placeholderPhase}
          cardSlug={cardSlug}
          rowKey={period}
        />
      </DashboardCardsValueGroup>
    </div>
  );
}
