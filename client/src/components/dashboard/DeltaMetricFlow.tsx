import { cn } from "../../cn";
import { plainNumberFlowParts, plainPercentNumberFlowParts } from "../../format";
import { AnimatedNumberFlow } from "./AnimatedNumberFlow";
import styles from "./CardGroupMetrics.module.css";
import type { DisplayUnit } from "../../queries/keys";

const METRIC_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const METRIC_TIMING = {
  transformTiming: { duration: 320, easing: METRIC_EASING },
  spinTiming: { duration: 320, easing: METRIC_EASING },
};

type Props = {
  delta: number | null;
  animated?: boolean;
  className?: string;
  fractionDigits?: number;
} & (
  | {
      deltaFormat?: "absolute";
      /** The unit of the payload the delta comes from (a held payload keeps its own), not the
       * display unit: the number flow rolls, never flashes, when it changes. */
      unit: DisplayUnit;
    }
  | { deltaFormat: "percent"; unit?: undefined }
);

export function DeltaMetricFlow({
  delta,
  animated = true,
  className = "",
  fractionDigits = 0,
  deltaFormat = "absolute",
  unit,
}: Props) {
  if (delta == null) {
    return (
      <span className={cn(styles.delta, className)}>
        <span className={cn(styles.deltaIcon, styles.deltaIconReserve)} aria-hidden>
          <span className={styles.deltaGlyph}>▲</span>
        </span>
        <span className={cn(styles.amount, styles.amountEmpty, "mono")}>—</span>
      </span>
    );
  }
  const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const tone =
    sign > 0 ? styles.deltaUp : sign < 0 ? styles.deltaDown : "";
  return (
    <span className={cn(styles.delta, tone, className)}>
      <span className={styles.deltaIcon} aria-hidden>
        <span className={styles.deltaGlyph}>{sign > 0 ? "▲" : sign < 0 ? "▼" : "◆"}</span>
      </span>
      <AnimatedNumberFlow
        value={delta}
        animated={animated}
        unit={unit}
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
