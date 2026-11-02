import { ReferenceLine } from "recharts";
import { UNDER_SERIES_Z_INDEX } from "./chartLayout";

export const PERIOD_REF_LINE_STROKE = "#94a3b8";

/**
 * The dotted vertical "current period" marker shared by the CC historial chart and the expenses
 * chart. Drawn under the series, as it was when Recharts painted in JSX order.
 */
export function renderPeriodRefLine({ x, label }: { x: string; label?: string }) {
  return (
    <ReferenceLine
      key={`period-ref-${x}`}
      x={x}
      stroke={PERIOD_REF_LINE_STROKE}
      strokeDasharray="4 4"
      strokeWidth={1.5}
      zIndex={UNDER_SERIES_Z_INDEX}
      label={
        label
          ? {
              value: label,
              position: "insideTopRight",
              fill: PERIOD_REF_LINE_STROKE,
              fontSize: 10,
            }
          : undefined
      }
    />
  );
}
