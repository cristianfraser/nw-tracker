import type { ReactElement } from "react";
import { ReferenceDot } from "recharts";

/** Half-diagonal of the diamond (px). */
const ATH_DIAMOND_HALF = 5;

/**
 * The ATH marker: a small diamond on the peak point, nothing else — the docked tooltip already
 * names that point's date and value on hover, so the marker carries no label of its own.
 * A plain function (not a component): Recharts only honors children whose element type it
 * knows, so this must return a `ReferenceDot` element directly — same rule as
 * `renderPeriodRefLine`. Placement (which grid row) is `athMarkerPlacement.ts`.
 */
export function renderAthMarker({
  x,
  y,
  color,
  opacity,
}: {
  /** Category x value of the plotted row carrying the peak. */
  x: string;
  /** The peak's value (a plotted point at this grain). */
  y: number;
  color: string;
  /** Follows the marked line's legend-focus dimming. */
  opacity: number;
}): ReactElement {
  const s = ATH_DIAMOND_HALF;
  return (
    <ReferenceDot
      key={`ath-${x}`}
      x={x}
      y={y}
      r={s}
      isFront
      ifOverflow="discard"
      shape={(p: { cx: number; cy: number }) => (
        <path
          d={`M${p.cx},${p.cy - s} L${p.cx + s},${p.cy} L${p.cx},${p.cy + s} L${p.cx - s},${p.cy} Z`}
          fill={color}
          stroke="#f8fafc"
          strokeWidth={1.5}
          opacity={opacity}
          style={{ pointerEvents: "none" }}
        />
      )}
    />
  );
}
