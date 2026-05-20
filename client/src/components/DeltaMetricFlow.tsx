import { plainNumberFlowParts, plainPercentNumberFlowParts } from "../format";
import { AnimatedNumberFlow, MOUNT_OPACITY_MS, useMountAnimation } from "./AnimatedNumberFlow";
import styles from "./CardGroupMetrics.module.css";

const METRIC_MOUNT_DIGIT_RANGE: [number, number] = [5, 7];
const METRIC_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const METRIC_TIMING = {
  transformTiming: { duration: 320, easing: METRIC_EASING },
  spinTiming: { duration: 320, easing: METRIC_EASING },
};

type Props = {
  delta: number | null;
  showUsd: boolean;
  animated?: boolean;
  mountSeedId?: string;
  className?: string;
  fractionDigits?: number;
  deltaFormat?: "absolute" | "percent";
};

export function DeltaMetricFlow({
  delta,
  showUsd,
  animated = true,
  mountSeedId = "delta",
  className = "",
  fractionDigits = 0,
  deltaFormat = "absolute",
}: Props) {
  const useMountSeed = animated && mountSeedId != null && delta != null;
  const mountAnimation = useMountAnimation(
    delta,
    animated,
    useMountSeed ? METRIC_MOUNT_DIGIT_RANGE : undefined,
    useMountSeed ? mountSeedId : undefined
  );

  if (delta == null) {
    return (
      <span className={`${styles.amount} ${styles.amountEmpty} mono ${className}`.trim()}>—</span>
    );
  }
  const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const tone =
    sign > 0 ? styles.deltaUp : sign < 0 ? styles.deltaDown : "";
  const unit = showUsd ? "usd" : "clp";
  return (
    <span
      className={`${styles.delta} ${tone} ${className}`.trim()}
      style={{
        opacity: mountAnimation.opacity,
        transition:
          useMountSeed && mountAnimation.opacityTransition
            ? `opacity ${MOUNT_OPACITY_MS}ms ${METRIC_EASING}`
            : undefined,
      }}
    >
      <span className={styles.deltaIcon} aria-hidden>
        {sign >= 0 ? "▲" : "▼"}
      </span>
      <AnimatedNumberFlow
        value={delta}
        animated={animated}
        mountSeedDigitRange={METRIC_MOUNT_DIGIT_RANGE}
        mountSeedId={mountSeedId}
        mountAnimation={mountAnimation}
        mapDisplayValue={(n) =>
          deltaFormat === "percent"
            ? plainPercentNumberFlowParts(n, fractionDigits)
            : plainNumberFlowParts(n, unit, fractionDigits)
        }
        className={`${styles.amount} mono`}
        transformTiming={METRIC_TIMING.transformTiming}
        spinTiming={METRIC_TIMING.spinTiming}
      />
    </span>
  );
}
