import { plainNumberFlowParts } from "../format";
import { AnimatedNumberFlow, useMountAnimation } from "./AnimatedNumberFlow";

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
  /** Decimal places for the delta digits (match the reference value in the same row). */
  fractionDigits?: number;
};

/** Signed delta with ▲/▼ and green/red tone (NumberFlow optional). */
export function DeltaMetricFlow({
  delta,
  showUsd,
  animated = true,
  mountSeedId = "delta",
  className = "",
  fractionDigits = 0,
}: Props) {
  const useMountSeed = animated && mountSeedId != null && delta != null;
  const mountAnimation = useMountAnimation(
    delta,
    animated,
    useMountSeed ? METRIC_MOUNT_DIGIT_RANGE : undefined,
    useMountSeed ? mountSeedId : undefined
  );

  if (delta == null) {
    return <span className={`card-group-metrics__amount card-group-metrics__amount--empty mono ${className}`.trim()}>—</span>;
  }
  const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const tone =
    sign > 0 ? "card-group-metrics__amount--delta-up" : sign < 0 ? "card-group-metrics__amount--delta-down" : "";
  const unit = showUsd ? "usd" : "clp";
  return (
    <span
      className={`card-group-metrics__delta ${tone} ${className}`.trim()}
      style={{
        opacity: mountAnimation.opacity,
        transition: useMountSeed
          ? `opacity ${mountAnimation.mountDuration}ms ${METRIC_EASING}`
          : undefined,
      }}
    >
      <span className="card-group-metrics__delta-icon" aria-hidden>
        {sign >= 0 ? "▲" : "▼"}
      </span>
      <AnimatedNumberFlow
        value={delta}
        animated={animated}
        mountSeedDigitRange={METRIC_MOUNT_DIGIT_RANGE}
        mountSeedId={mountSeedId}
        mountAnimation={mountAnimation}
        mapDisplayValue={(n) => plainNumberFlowParts(n, unit, fractionDigits)}
        className="card-group-metrics__amount mono"
        transformTiming={METRIC_TIMING.transformTiming}
        spinTiming={METRIC_TIMING.spinTiming}
      />
    </span>
  );
}
