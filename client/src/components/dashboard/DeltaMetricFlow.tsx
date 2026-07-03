import { cn } from "../../cn";
import { plainNumberFlowParts, plainPercentNumberFlowParts } from "../../format";
import { AnimatedNumberFlow, MOUNT_OPACITY_MS, useMountAnimation } from "./AnimatedNumberFlow";
import styles from "./CardGroupMetrics.module.css";

const METRIC_MOUNT_DIGIT_RANGE: [number, number] = [5, 7];
/** Percent deltas (e.g. watchlist 1d / MTD) — avoid 5–7 digit CLP-style mount seeds. */
const PERCENT_MOUNT_DIGIT_RANGE: [number, number] = [1, 2];
const METRIC_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const METRIC_TIMING = {
  transformTiming: { duration: 320, easing: METRIC_EASING },
  spinTiming: { duration: 320, easing: METRIC_EASING },
};

type Props = {
  delta: number | null;
  animated?: boolean;
  mountSeedId?: string;
  className?: string;
  fractionDigits?: number;
  deltaFormat?: "absolute" | "percent";
  placeholderPhase?: boolean;
};

export function DeltaMetricFlow({
  delta,
  animated = true,
  mountSeedId = "delta",
  className = "",
  fractionDigits = 0,
  deltaFormat = "absolute",
  placeholderPhase = false,
}: Props) {
  const mountDigitRange =
    deltaFormat === "percent" ? PERCENT_MOUNT_DIGIT_RANGE : METRIC_MOUNT_DIGIT_RANGE;
  const useMountSeed = animated && mountSeedId != null && delta != null;
  const mountAnimation = useMountAnimation(
    delta,
    animated,
    useMountSeed ? mountDigitRange : undefined,
    useMountSeed ? mountSeedId : undefined,
    placeholderPhase
  );

  if (delta == null) {
    return (
      <span className={cn(styles.delta, className)}>
        <span className={cn(styles.deltaIcon, styles.deltaIconReserve)} aria-hidden>
          ▲
        </span>
        <span className={cn(styles.amount, styles.amountEmpty, "mono")}>—</span>
      </span>
    );
  }
  const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const tone =
    sign > 0 ? styles.deltaUp : sign < 0 ? styles.deltaDown : "";
  return (
    <span
      className={cn(styles.delta, tone, className)}
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
        mountSeedDigitRange={mountDigitRange}
        mountSeedId={mountSeedId}
        mountAnimation={mountAnimation}
        placeholderPhase={placeholderPhase}
        mapDisplayValue={(n) =>
          deltaFormat === "percent"
            ? plainPercentNumberFlowParts(n, fractionDigits)
            : plainNumberFlowParts(n, fractionDigits)
        }
        className={cn(styles.amount, "mono")}
        transformTiming={METRIC_TIMING.transformTiming}
        spinTiming={METRIC_TIMING.spinTiming}
      />
    </span>
  );
}
