import { cn } from "../../cn";
import SketchMarker, { type SketchMarkerShape } from "../charts/SketchMarker";
import { useChartStyle } from "../charts/chartStyle";
import styles from "./ColorMarker.module.css";

/**
 * A colour mark — a group's square, the expenses triangle: flat in the plain chart style,
 * hand-drawn in the others (the box legend's square, the triangle in the same hand). It fills the
 * element it is placed in (the caller sizes and places it): the sidebar's rows and the investment
 * group table's colour hints.
 */
export function ColorMarker({
  color,
  shape = "square",
  className,
}: {
  color: string;
  shape?: SketchMarkerShape;
  className?: string;
}) {
  const sketched = useChartStyle() !== "plain";
  return (
    <span className={cn(styles.marker, className)} aria-hidden>
      {sketched ? (
        <SketchMarker color={color} shape={shape} className={styles.sketch} />
      ) : (
        <span
          className={cn(styles.flat, shape === "triangle-down" && styles.flatTriangle)}
          style={{ backgroundColor: color }}
        />
      )}
    </span>
  );
}
