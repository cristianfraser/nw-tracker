import { cn } from "../../cn";
import {
  roundedMetricDelta,
  roundedMetricDeposits,
  type CardGroupMetricsByPeriod,
} from "../../dashboardCardBreakdown";
import {
  accountingCurrencyNumberFlowParts,
  currencyHasAdaptiveCardDecimals,
  minAdaptiveUsdFractionDigits,
} from "../../format";
import type { DisplayUnit } from "../../queries/keys";
import { useTranslation } from "../../i18n";
import { AnimatedNumberFlow } from "./AnimatedNumberFlow";
import { DashboardCardsValueGroup } from "./DashboardCardValue";
import { DeltaMetricFlow } from "./DeltaMetricFlow";
import styles from "./CardGroupMetrics.module.css";
const METRIC_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const METRIC_TIMING = {
  transformTiming: { duration: 320, easing: METRIC_EASING },
  spinTiming: { duration: 320, easing: METRIC_EASING },
};

type Props = {
  /** All three period slices; rows carry no visible labels (tooltip + a11y text only). */
  metricsByPeriod: CardGroupMetricsByPeriod;
  /** The unit the card shows (its metrics are in it). */
  unit: DisplayUnit;
  animated?: boolean;
};

/** Shared decimal alignment for every Δ on the card (the balance-row day Δ included). */
export function cardDeltaFractionDigits(
  metricsByPeriod: CardGroupMetricsByPeriod,
  unit: DisplayUnit
): number {
  if (!currencyHasAdaptiveCardDecimals(unit)) return 0;
  return minAdaptiveUsdFractionDigits([
    roundedMetricDelta(metricsByPeriod.month, unit, "total"),
    roundedMetricDelta(metricsByPeriod.day, unit, "period"),
    roundedMetricDelta(metricsByPeriod.month, unit, "period"),
    roundedMetricDelta(metricsByPeriod.year, unit, "period"),
  ]);
}

/**
 * Day P/L rendered on the card's balance row (`valueDelta` slot of the card components) —
 * the day period has no deposits row of its own, only this Δ. Label lives in the tooltip
 * and a11y text, not the layout.
 */
export function CardValueDayPl({
  metricsByPeriod,
  unit,
  animated = true,
}: Props) {
  const { t } = useTranslation();
  const label = t("dashboard.cardBreakdown.periodDeltaDay");
  return (
    <span className={styles.valueDayPl} title={label}>
      <span className="visually-hidden">{label}</span>
      <DeltaMetricFlow
        delta={roundedMetricDelta(metricsByPeriod.day, unit, "period")}
        animated={animated}
        fractionDigits={cardDeltaFractionDigits(metricsByPeriod, unit)}
      />
    </span>
  );
}

/** Bare deposits/amount cell (also used by the leaf-bucket accounts summary table). */
export function DepositedMetricFlow({
  value,
  unit,
  animated,
}: {
  value: number | null;
  unit: DisplayUnit;
  animated: boolean;
}) {
  if (value == null) {
    return <span className={cn(styles.amount, styles.amountEmpty, "mono")}>—</span>;
  }
  return (
    <AnimatedNumberFlow
      value={value}
      animated={animated}
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
  unit,
  animated,
  dim = false,
}: {
  deposited: number | null;
  depositedLabel: string;
  delta: number | null;
  deltaLabel: string;
  deltaFractionDigits: number;
  unit: DisplayUnit;
  animated: boolean;
  dim?: boolean;
}) {
  return (
    <div className={cn(styles.row, dim && styles.rowDim)}>
      <span className={styles.deposited} title={depositedLabel}>
        <span className="visually-hidden">{depositedLabel}</span>
        {/* Only the P/L figures animate (and the card's balance); the deposits stay still. */}
        <DepositedMetricFlow value={deposited} unit={unit} animated={false} />
      </span>
      <span className={styles.deltaWrap} title={deltaLabel}>
        <DeltaMetricFlow
          delta={delta}
          animated={animated}
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
  unit,
  animated = true,
}: Props) {
  const { t } = useTranslation();

  // Lifetime fields are identical across slices — read them from the month slice.
  const lifetime = metricsByPeriod.month;
  const deltaFractionDigits = cardDeltaFractionDigits(metricsByPeriod, unit);
  const shared = { deltaFractionDigits, unit, animated };

  return (
    <div className={styles.root} aria-label={t("dashboard.cardBreakdown.summaryAria")}>
      <DashboardCardsValueGroup>
        <MetricsRow
          {...shared}
          deposited={roundedMetricDeposits(metricsByPeriod.month, "period")}
          depositedLabel={t("dashboard.cardBreakdown.periodDepositsMonth")}
          delta={roundedMetricDelta(metricsByPeriod.month, unit, "period")}
          deltaLabel={t("dashboard.cardBreakdown.periodDeltaMonth")}
        />
        <MetricsRow
          {...shared}
          deposited={roundedMetricDeposits(metricsByPeriod.year, "period")}
          depositedLabel={t("dashboard.cardBreakdown.periodDepositsYear")}
          delta={roundedMetricDelta(metricsByPeriod.year, unit, "period")}
          deltaLabel={t("dashboard.cardBreakdown.periodDeltaYear")}
        />
        <span className="card-divider" aria-hidden="true" />
        <MetricsRow
          {...shared}
          deposited={roundedMetricDeposits(lifetime, "total")}
          depositedLabel={t("dashboard.cardBreakdown.totalDeposited")}
          delta={roundedMetricDelta(lifetime, unit, "total")}
          deltaLabel={t("dashboard.cardBreakdown.totalDelta")}
          dim
        />
      </DashboardCardsValueGroup>
    </div>
  );
}
