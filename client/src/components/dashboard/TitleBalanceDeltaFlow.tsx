import { cn } from "../../cn";
import { titleBalanceDeltaNumberFlowParts } from "../../format";
import { AnimatedNumberFlow, MOUNT_OPACITY_MS, useMountAnimation } from "./AnimatedNumberFlow";

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
  placeholderPhase?: boolean;
};

/** Title-row period balance change: muted, `+` / accounting parentheses (not ▲/▼ or P/L colors). */
export function TitleBalanceDeltaFlow({
  delta,
  showUsd,
  animated = true,
  mountSeedId = "title-balance-delta",
  className = "",
  placeholderPhase = false,
}: Props) {
  const useMountSeed = animated && mountSeedId != null && delta != null;
  const mountAnimation = useMountAnimation(
    delta,
    animated,
    useMountSeed ? METRIC_MOUNT_DIGIT_RANGE : undefined,
    useMountSeed ? mountSeedId : undefined,
    placeholderPhase
  );

  // Genuinely unknown Δ only (e.g. missing fx) — opened-this-period accounts get a
  // real 0-based Δ from the server (`priorCloseFromPerfRows`), and Δ = 0 renders `$0`
  // through the flow below. Same wrapper classes as the value branch so a residual
  // dash swap never shifts the title row.
  if (delta == null) {
    return <span className={cn("mono", className)}>—</span>;
  }

  const unit = showUsd ? "usd" : "clp";
  return (
    <span
      className={cn("mono", className)}
      style={{
        opacity: mountAnimation.opacity,
        transition:
          useMountSeed && mountAnimation.opacityTransition
            ? `opacity ${MOUNT_OPACITY_MS}ms ${METRIC_EASING}`
            : undefined,
      }}
    >
      <AnimatedNumberFlow
        value={delta}
        animated={animated}
        mountSeedDigitRange={METRIC_MOUNT_DIGIT_RANGE}
        mountSeedId={mountSeedId}
        mountAnimation={mountAnimation}
        placeholderPhase={placeholderPhase}
        mapDisplayValue={(n) => titleBalanceDeltaNumberFlowParts(n, unit, "$")}
        className="mono"
        transformTiming={METRIC_TIMING.transformTiming}
        spinTiming={METRIC_TIMING.spinTiming}
      />
    </span>
  );
}
