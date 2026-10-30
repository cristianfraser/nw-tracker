import type { ReactElement } from "react";
import { ReferenceDot } from "recharts";

/** The marker's tint: a pale gold, a shade darker than the white net-worth line it marks. */
export const ATH_MARKER_STROKE = "#d9c48f";
/** Base opacity of the marker; the line's legend-focus dimming multiplies it. */
const ATH_MARKER_OPACITY = 0.55;
const ATH_MARKER_WIDTH = 2;
/** Height of the tick, centered on the peak point (px). */
const ATH_MARKER_HEIGHT = 12;

/**
 * The ATH marker: a short translucent vertical tick on the peak point, nothing else — the
 * docked tooltip already names that point's date and value on hover, so the marker carries no
 * label of its own.
 * A plain function (not a component): Recharts only honors children whose element type it
 * knows, so this must return a `ReferenceDot` element directly — same rule as
 * `renderPeriodRefLine`. Placement (which grid row) is `athMarkerPlacement.ts`.
 */
export function renderAthMarker({
  x,
  y,
  opacity,
}: {
  /** Category x value of the plotted row carrying the peak. */
  x: string;
  /** The peak's value (a plotted point at this grain). */
  y: number;
  /** Follows the marked line's legend-focus dimming. */
  opacity: number;
}): ReactElement {
  const w = ATH_MARKER_WIDTH;
  const h = ATH_MARKER_HEIGHT;
  return (
    <ReferenceDot
      key={`ath-${x}`}
      x={x}
      y={y}
      r={h / 2}
      isFront
      ifOverflow="discard"
      shape={(p: { cx: number; cy: number }) => (
        <rect
          x={p.cx - w / 2}
          y={p.cy - h / 2}
          width={w}
          height={h}
          fill={ATH_MARKER_STROKE}
          fillOpacity={ATH_MARKER_OPACITY * opacity}
          style={{ pointerEvents: "none" }}
        />
      )}
    />
  );
}
