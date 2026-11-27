/**
 * The PDF viewer's scale rules (PdfPreview.tsx). A scale is pdf.js's viewport scale: CSS pixels
 * per PDF point (1 = 72 dpi, a little under a browser viewer's «100 %», which is 96/72).
 */

export const PDF_MIN_SCALE = 0.25;
export const PDF_MAX_SCALE = 5;

/** The zoom buttons step along this ladder; fit-width can land between two steps. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/**
 * A canvas larger than this many pixels fails on iOS Safari (its limit is 4096 × 4096); a page
 * that big at the device's pixel ratio renders at a lower ratio instead.
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

/** pdf.js's own cap on phones and tablets (its viewer's `maxCanvasPixels` there): less memory per page. */
export const MAX_CANVAS_PIXELS_TOUCH = 5_242_880;

/** The per-canvas pixel cap: the lower one on a touch device (coarse pointer or touch points). */
export function canvasPixelCap(touchDevice: boolean): number {
  return touchDevice ? MAX_CANVAS_PIXELS_TOUCH : MAX_CANVAS_PIXELS;
}

export function clampPdfScale(scale: number): number {
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale));
}

/** The scale at which the widest page fills the width available to it. */
export function fitWidthScale(availableWidth: number, widestPageWidth: number): number {
  if (!(widestPageWidth > 0)) throw new Error(`pdf viewer: no page width to fit (${widestPageWidth})`);
  return clampPdfScale(Math.max(0, availableWidth) / widestPageWidth);
}

/**
 * The next ladder step above (`1`) or below (`-1`) the current scale; a scale within 1 % of a step
 * counts as on it, so a click always moves visibly. At either end the scale stays at the bound.
 */
export function stepPdfScale(current: number, direction: 1 | -1): number {
  const next =
    direction === 1
      ? ZOOM_STEPS.find((s) => s > current * 1.01)
      : [...ZOOM_STEPS].reverse().find((s) => s < current * 0.99);
  return next ?? (direction === 1 ? PDF_MAX_SCALE : PDF_MIN_SCALE);
}

/** Whether a zoom button can still move the scale (false at the bound it points to). */
export function canStepPdfScale(current: number, direction: 1 | -1): boolean {
  return stepPdfScale(current, direction) !== current;
}

/** Canvas pixels per CSS pixel for a page of this size: the device's ratio, lowered to fit the cap. */
export function canvasPixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels: number
): number {
  const ratio = Math.max(1, devicePixelRatio);
  const area = cssWidth * cssHeight;
  if (!(area > 0)) return ratio;
  return Math.min(ratio, Math.sqrt(maxPixels / area));
}
