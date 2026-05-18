import type { CardGroupMetrics, CardGroupMetricsPeriod } from "../dashboardCardBreakdown";
import { accountingCurrencyNumberFlowParts, plainNumberFlowParts } from "../format";
import { useTranslation } from "../i18n";
import { AnimatedNumberFlow } from "./AnimatedNumberFlow";
import { DashboardCardsValueGroup } from "./DashboardCardValue";

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
};

function DepositedMetricFlow({
  value,
  showUsd,
  animated,
  mountSeedId,
}: {
  value: number | null;
  showUsd: boolean;
  animated: boolean;
  mountSeedId: string;
}) {
  if (value == null) {
    return <span className="card-group-metrics__amount card-group-metrics__amount--empty mono">—</span>;
  }
  const unit = showUsd ? "usd" : "clp";
  return (
    <AnimatedNumberFlow
      value={value}
      animated={animated}
      mountSeedDigitRange={METRIC_MOUNT_DIGIT_RANGE}
      mountSeedId={mountSeedId}
      mapDisplayValue={(n) => accountingCurrencyNumberFlowParts(n, unit, "$")}
      className="card-group-metrics__amount mono"
      transformTiming={METRIC_TIMING.transformTiming}
      spinTiming={METRIC_TIMING.spinTiming}
    />
  );
}

function DeltaMetricFlow({
  delta,
  showUsd,
  animated,
  mountSeedId,
}: {
  delta: number | null;
  showUsd: boolean;
  animated: boolean;
  mountSeedId: string;
}) {
  if (delta == null) {
    return <span className="card-group-metrics__amount card-group-metrics__amount--empty mono">—</span>;
  }
  const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const tone =
    sign > 0 ? "card-group-metrics__amount--delta-up" : sign < 0 ? "card-group-metrics__amount--delta-down" : "";
  const unit = showUsd ? "usd" : "clp";
  return (
    <span className={`card-group-metrics__delta ${tone}`}>
      <span className="card-group-metrics__delta-icon" aria-hidden>
        {sign >= 0 ? "▲" : "▼"}
      </span>
      <AnimatedNumberFlow
        value={delta}
        animated={animated}
        mountSeedDigitRange={METRIC_MOUNT_DIGIT_RANGE}
        mountSeedId={mountSeedId}
        mapDisplayValue={(n) => plainNumberFlowParts(n, unit)}
        className={`card-group-metrics__amount mono ${tone}`}
        transformTiming={METRIC_TIMING.transformTiming}
        spinTiming={METRIC_TIMING.spinTiming}
      />
    </span>
  );
}

function MetricsRow({
  deposited,
  depositedLabel,
  delta,
  deltaLabel,
  showUsd,
  animated,
  cardSlug,
  rowKey,
}: {
  deposited: number | null;
  depositedLabel: string;
  delta: number | null;
  deltaLabel: string;
  showUsd: boolean;
  animated: boolean;
  cardSlug: string;
  rowKey: string;
}) {
  return (
    <div className="card-group-metrics__row">
      <span className="card-group-metrics__deposited">
        <span className="visually-hidden">{depositedLabel}</span>
        <DepositedMetricFlow
          value={deposited}
          showUsd={showUsd}
          animated={animated}
          mountSeedId={`${cardSlug}:deposited:${rowKey}`}
        />
      </span>
      <span className="card-group-metrics__delta-wrap" title={deltaLabel}>
        <DeltaMetricFlow
          delta={delta}
          showUsd={showUsd}
          animated={animated}
          mountSeedId={`${cardSlug}:delta:${rowKey}`}
        />
      </span>
    </div>
  );
}

function metricDeposited(
  metrics: CardGroupMetrics,
  showUsd: boolean,
  kind: "total" | "period"
): number | null {
  if (kind === "total") {
    if (showUsd) {
      if (metrics.deposits_usd != null && Number.isFinite(metrics.deposits_usd)) {
        return Math.round(metrics.deposits_usd);
      }
      return null;
    }
    return Math.round(metrics.deposits_clp);
  }
  if (showUsd) {
    if (metrics.deposits_period_usd != null && Number.isFinite(metrics.deposits_period_usd)) {
      return Math.round(metrics.deposits_period_usd);
    }
    return null;
  }
  return Math.round(metrics.deposits_period_clp);
}

function metricDelta(metrics: CardGroupMetrics, showUsd: boolean, kind: "total" | "period"): number | null {
  const clp = kind === "total" ? metrics.delta_total_clp : metrics.delta_period_clp;
  if (showUsd) {
    const usd = kind === "total" ? metrics.delta_total_usd : metrics.delta_period_usd;
    if (usd != null && Number.isFinite(usd)) return Math.round(usd);
    return null;
  }
  return clp != null && Number.isFinite(clp) ? Math.round(clp) : null;
}

/** Two rows below the card total: lifetime deposits/Δ, then period deposits/Δ. */
export function DashboardCardGroupMetrics({
  metrics,
  showUsd,
  period,
  cardSlug,
  animated = true,
}: Props) {
  const { t } = useTranslation();
  const periodDepositsLabel =
    period === "year"
      ? t("dashboard.cardBreakdown.periodDepositsYear")
      : t("dashboard.cardBreakdown.periodDepositsMonth");
  const periodDeltaLabel =
    period === "year"
      ? t("dashboard.cardBreakdown.periodDeltaYear")
      : t("dashboard.cardBreakdown.periodDeltaMonth");

  return (
    <div className="card-group-metrics" aria-label={t("dashboard.cardBreakdown.summaryAria")}>
      <DashboardCardsValueGroup>
        <MetricsRow
          deposited={metricDeposited(metrics, showUsd, "total")}
          depositedLabel={t("dashboard.cardBreakdown.totalDeposited")}
          delta={metricDelta(metrics, showUsd, "total")}
          deltaLabel={t("dashboard.cardBreakdown.totalDelta")}
          showUsd={showUsd}
          animated={animated}
          cardSlug={cardSlug}
          rowKey="total"
        />
        <MetricsRow
          deposited={metricDeposited(metrics, showUsd, "period")}
          depositedLabel={periodDepositsLabel}
          delta={metricDelta(metrics, showUsd, "period")}
          deltaLabel={periodDeltaLabel}
          showUsd={showUsd}
          animated={animated}
          cardSlug={cardSlug}
          rowKey={period}
        />
      </DashboardCardsValueGroup>
    </div>
  );
}
