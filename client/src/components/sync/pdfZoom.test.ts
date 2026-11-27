import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_PIXELS_TOUCH,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  canStepPdfScale,
  canvasPixelCap,
  canvasPixelRatio,
  fitWidthScale,
  stepPdfScale,
} from "./pdfZoom";

describe("fitWidthScale", () => {
  it("fills the available width with the widest page, within the bounds", () => {
    expect(fitWidthScale(612, 612)).toBe(1);
    expect(fitWidthScale(351, 595)).toBeCloseTo(0.59, 2);
    expect(fitWidthScale(20, 595)).toBe(PDF_MIN_SCALE);
    expect(fitWidthScale(-10, 595)).toBe(PDF_MIN_SCALE);
    expect(fitWidthScale(10_000, 100)).toBe(PDF_MAX_SCALE);
  });

  it("throws without a page width", () => {
    expect(() => fitWidthScale(600, 0)).toThrow();
  });
});

describe("stepPdfScale", () => {
  it("moves to the next step, from on a step or between two", () => {
    expect(stepPdfScale(1, 1)).toBe(1.1);
    expect(stepPdfScale(1, -1)).toBe(0.9);
    expect(stepPdfScale(0.59, 1)).toBe(0.67);
    expect(stepPdfScale(0.59, -1)).toBe(0.5);
    // Within 1 % of a step counts as on it.
    expect(stepPdfScale(0.995, 1)).toBe(1.1);
  });

  it("stays at the bounds, where its button is off", () => {
    expect(stepPdfScale(PDF_MAX_SCALE, 1)).toBe(PDF_MAX_SCALE);
    expect(stepPdfScale(PDF_MIN_SCALE, -1)).toBe(PDF_MIN_SCALE);
    expect(canStepPdfScale(PDF_MAX_SCALE, 1)).toBe(false);
    expect(canStepPdfScale(PDF_MIN_SCALE, -1)).toBe(false);
    expect(canStepPdfScale(PDF_MAX_SCALE, -1)).toBe(true);
    // Just above the floor (a narrow fit-width) can still step down to it.
    expect(canStepPdfScale(0.26, -1)).toBe(true);
  });
});

describe("canvasPixelRatio", () => {
  it("uses the device ratio until the canvas would pass the pixel cap", () => {
    expect(canvasPixelRatio(600, 800, 2, MAX_CANVAS_PIXELS)).toBe(2);
    expect(canvasPixelRatio(600, 800, 0.5, MAX_CANVAS_PIXELS)).toBe(1);
    const big = canvasPixelRatio(3000, 4000, 3, MAX_CANVAS_PIXELS);
    expect(big).toBeLessThan(3);
    expect(3000 * big * 4000 * big).toBeCloseTo(MAX_CANVAS_PIXELS, -2);
  });

  it("caps a touch device's canvas at pdf.js's mobile figure", () => {
    expect(canvasPixelCap(true)).toBe(MAX_CANVAS_PIXELS_TOUCH);
    expect(canvasPixelCap(false)).toBe(MAX_CANVAS_PIXELS);
    // A phone-width page at 3x fits under the touch cap only at a lower ratio.
    const r = canvasPixelRatio(1190, 1684, 3, canvasPixelCap(true));
    expect(1190 * r * 1684 * r).toBeCloseTo(MAX_CANVAS_PIXELS_TOUCH, -2);
  });
});
