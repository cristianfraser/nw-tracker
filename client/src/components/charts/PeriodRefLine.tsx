import { ReferenceLine } from "recharts";

export const PERIOD_REF_LINE_STROKE = "#94a3b8";

/**
 * The dotted vertical "current period" marker shared by the CC historial chart and the expenses
 * chart. A plain function (not a component): Recharts only honors children whose element type it
 * knows, so this must return a `ReferenceLine` element directly.
 */
export function renderPeriodRefLine({ x, label }: { x: string; label?: string }) {
  return (
    <ReferenceLine
      key={`period-ref-${x}`}
      x={x}
      stroke={PERIOD_REF_LINE_STROKE}
      strokeDasharray="4 4"
      strokeWidth={1.5}
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
