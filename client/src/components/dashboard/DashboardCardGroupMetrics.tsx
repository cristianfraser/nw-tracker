import { cn } from "../../cn";
import {
  roundedMetricDelta,
  roundedMetricDeposits,
  type CardGroupMetricsByPeriod,
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
  /** All three period slices; rows carry no visible labels (tooltip + a11y text only). */
  metricsByPeriod: CardGroupMetricsByPeriod;
  showUsd: boolean;
  cardSlug: string;
  animated?: boolean;
  placeholderPhase?: boolean;
};

/** Shared decimal alignment for every Δ on the card (the balance-row day Δ included). */
export function cardDeltaFractionDigits(
  metricsByPeriod: CardGroupMetricsByPeriod,
  showUsd: boolean
): number {
  if (!showUsd) return 0;
  return minAdaptiveUsdFractionDigits([
    roundedMetricDelta(metricsByPeriod.month, showUsd, "total"),
    roundedMetricDelta(metricsByPeriod.day, showUsd, "period"),
    roundedMetricDelta(metricsByPeriod.month, showUsd, "period"),
    roundedMetricDelta(metricsByPeriod.year, showUsd, "period"),
  ]);
}

/**
 * Day P/L rendered on the card's balance row (`valueDelta` slot of the card components) —
 * the day period has no deposits row of its own, only this Δ. Label lives in the tooltip
 * and a11y text, not the layout.
 */
export function CardValueDayPl({
  metricsByPeriod,
  showUsd,
  cardSlug,
  animated = true,
  placeholderPhase = false,
}: Props) {
  const { t } = useTranslation();
  const label = t("dashboard.cardBreakdown.periodDeltaDay");
  return (
    <span className={styles.valueDayPl} title={label}>
      <span className="visually-hidden">{label}</span>
      <DeltaMetricFlow
        delta={roundedMetricDelta(metricsByPeriod.day, showUsd, "period")}
        animated={animated}
        placeholderPhase={placeholderPhase}
        mountSeedId={`${cardSlug}:delta:day`}
        fractionDigits={cardDeltaFractionDigits(metricsByPeriod, showUsd)}
      />
    </span>
  );
}

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
      mapDisplayValue={(n) => accountingCurrencyNumberFlowParts(n, unit, "bare")}
      className={cn(styles.amount, "mono")}
      transformTiming={METRIC_TIMING.transformTiming}
      spinTiming={METRIC_TIMING.spinTiming}
    />
  );
}

/** One `deposits | Δ` row; labels are tooltips + visually-hidden text only. */
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
  dim = false,
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
  dim?: boolean;
}) {
  return (
    <div className={cn(styles.row, dim && styles.rowDim)}>
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
    </div>
  );
}

/**
 * Card metrics: `mes deposits|Δ`, `año deposits|Δ`, then a dimmed lifetime
 * `total deposits|Δ` row below a divider. The day Δ sits on the balance row
 * (`CardValueDayPl`); the day period shows no deposits figure by design.
 */
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
  const deltaFractionDigits = cardDeltaFractionDigits(metricsByPeriod, showUsd);
  const shared = { deltaFractionDigits, showUsd, animated, placeholderPhase, cardSlug };

  return (
    <div className={styles.root} aria-label={t("dashboard.cardBreakdown.summaryAria")}>
      <DashboardCardsValueGroup>
        <MetricsRow
          {...shared}
          deposited={roundedMetricDeposits(metricsByPeriod.month, showUsd, "period")}
          depositedLabel={t("dashboard.cardBreakdown.periodDepositsMonth")}
          delta={roundedMetricDelta(metricsByPeriod.month, showUsd, "period")}
          deltaLabel={t("dashboard.cardBreakdown.periodDeltaMonth")}
          rowKey="month"
        />
        <MetricsRow
          {...shared}
          deposited={roundedMetricDeposits(metricsByPeriod.year, showUsd, "period")}
          depositedLabel={t("dashboard.cardBreakdown.periodDepositsYear")}
          delta={roundedMetricDelta(metricsByPeriod.year, showUsd, "period")}
          deltaLabel={t("dashboard.cardBreakdown.periodDeltaYear")}
          rowKey="year"
        />
        <span className={styles.divider} aria-hidden="true" />
        <MetricsRow
          {...shared}
          deposited={roundedMetricDeposits(lifetime, showUsd, "total")}
          depositedLabel={t("dashboard.cardBreakdown.totalDeposited")}
          delta={roundedMetricDelta(lifetime, showUsd, "total")}
          deltaLabel={t("dashboard.cardBreakdown.totalDelta")}
          rowKey="total"
          dim
        />
      </DashboardCardsValueGroup>
    </div>
  );
}
