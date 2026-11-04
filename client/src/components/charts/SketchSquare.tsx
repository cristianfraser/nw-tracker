import { RoughSwatchBox } from "./roughShapes";

/**
 * A colour square in the hand-drawn chart styles (the box legend's square), for HTML that sits
 * outside a chart: it fills the element it is placed in. A default export so the entry chunk can
 * load it lazily (`lazy(() => import(...))`) and keep the sketch code in the charts chunk.
 */
export default function SketchSquare({ color, className }: { color: string; className?: string }) {
  // The box is drawn 10 units wide in a 14-unit view: the view overhangs the element so the box
  // itself is the element's size.
  return (
    <svg className={className} viewBox="0 0 14 14" overflow="visible" aria-hidden>
      <RoughSwatchBox color={color} />
    </svg>
  );
}
