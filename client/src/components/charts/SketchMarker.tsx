import { RoughSwatchBox, RoughSwatchTriangleDown } from "./roughShapes";

export type SketchMarkerShape = "square" | "triangle-down";

/**
 * A colour marker in the hand-drawn chart styles — the box legend's square, or the expenses
 * favicon's triangle — for HTML that sits outside a chart (the sidebar): it fills the element it
 * is placed in.
 */
export default function SketchMarker({
  color,
  shape,
  className,
}: {
  color: string;
  shape: SketchMarkerShape;
  className?: string;
}) {
  // The shapes are drawn 10 units wide in a 14-unit view: the view overhangs the element so the
  // shape itself is the element's size.
  return (
    <svg className={className} viewBox="0 0 14 14" overflow="visible" aria-hidden>
      {shape === "square" ? <RoughSwatchBox color={color} /> : <RoughSwatchTriangleDown color={color} />}
    </svg>
  );
}
