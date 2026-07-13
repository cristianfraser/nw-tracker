import { describe, expect, it } from "vitest";
import { computeTooltipPlacement, horizontalGuideRect, TOOLTIP_VIEWPORT_INSET_PX } from "./ChartTooltip";

const VIEWPORT = { width: 1280, height: 800 };

/** Typical flip rise: plot height (300) + 2×4px gap + tooltip height (100). */
const FLIP_RISE = 300 + 8 + 100;

function rect(left: number, top: number, width: number, height: number) {
  return { left, right: left + width, top, bottom: top + height };
}

describe("computeTooltipPlacement", () => {
  it("stays below with zero offset when the tooltip fits inside panel and viewport", () => {
    const tip = rect(500, 300, 200, 100);
    const panel = rect(100, 100, 1000, 500);
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({ x: 0, y: 0, placement: "below" });
  });

  it("nudges right when overflowing the panel's left edge", () => {
    const tip = rect(90, 300, 200, 100);
    const panel = rect(100, 100, 1000, 500);
    // minLeft = panel.left + inset = 110 → dx = 110 - 90 = 20
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({ x: 20, y: 0, placement: "below" });
  });

  it("nudges left when overflowing the panel's right edge", () => {
    const tip = rect(1000, 300, 200, 100); // right = 1200 > panel.right - inset = 1090
    const panel = rect(100, 100, 1000, 500);
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({
      x: 1090 - 1200,
      y: 0,
      placement: "below",
    });
  });

  it("clamps to the viewport when there is no panel", () => {
    const tip = rect(-30, 300, 200, 100);
    expect(computeTooltipPlacement(tip, FLIP_RISE, null, VIEWPORT)).toEqual({
      x: TOOLTIP_VIEWPORT_INSET_PX + 30,
      y: 0,
      placement: "below",
    });
  });

  it("viewport right edge binds when tighter than the panel", () => {
    const tip = rect(1200, 300, 200, 100); // right = 1400
    const panel = rect(100, 100, 2000, 500); // panel.right - inset = 2090, viewport binds at 1270
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({
      x: 1270 - 1400,
      y: 0,
      placement: "below",
    });
  });

  it("flips above the plot when overflowing the viewport bottom", () => {
    const tip = rect(500, 750, 200, 100); // bottom = 850 > 790
    const panel = rect(100, 300, 1000, 480); // panel on-screen
    // flipped top = 750 - FLIP_RISE = 342 ≥ inset → clean flip, no extra offset
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({ x: 0, y: 0, placement: "above" });
  });

  it("keeps the horizontal clamp when flipping above", () => {
    const tip = rect(1000, 750, 200, 100);
    const panel = rect(100, 300, 1000, 480);
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({
      x: 1090 - 1200,
      y: 0,
      placement: "above",
    });
  });

  it("nudges the flipped tooltip down as a last resort when it would overflow the top", () => {
    const tip = rect(500, 750, 200, 100);
    const flipRise = 900; // viewport shorter than plot + tooltip: flipped top = -150 < inset
    const { x, y, placement } = computeTooltipPlacement(tip, flipRise, null, VIEWPORT);
    expect(x).toBe(0);
    expect(placement).toBe("above");
    expect(750 - flipRise + y).toBe(TOOLTIP_VIEWPORT_INSET_PX);
  });

  it("nudges down when below the plot but above the viewport top", () => {
    const tip = rect(500, -25, 200, 100);
    expect(computeTooltipPlacement(tip, FLIP_RISE, null, VIEWPORT)).toEqual({
      x: 0,
      y: TOOLTIP_VIEWPORT_INSET_PX + 25,
      placement: "below",
    });
  });

  it("panel never clamps vertically (dock sits below the plot inside the chart box)", () => {
    const tip = rect(500, 550, 200, 100); // bottom = 650, inside viewport but below panel.bottom = 600
    const panel = rect(100, 100, 1000, 500);
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({ x: 0, y: 0, placement: "below" });
  });

  it("never flips when the chart panel scrolled out of view (stale tooltip)", () => {
    const tip = rect(500, 900, 200, 140); // still-mounted tooltip of a chart below the fold
    const panel = rect(100, 810, 1000, 500); // panel entirely under the viewport
    expect(computeTooltipPlacement(tip, FLIP_RISE, panel, VIEWPORT)).toEqual({ x: 0, y: 0, placement: "below" });
  });

  it("skips vertical handling without a panel when the tooltip itself is fully off-screen", () => {
    const tip = rect(500, -1300, 200, 140);
    expect(computeTooltipPlacement(tip, FLIP_RISE, null, VIEWPORT)).toEqual({ x: 0, y: 0, placement: "below" });
  });
});

describe("horizontalGuideRect", () => {
  // Plot band: y ∈ [40, 340], x from 60 spanning 900px.
  const viewBox = { x: 60, y: 40, width: 900, height: 300 };

  it("spans the plot width at the hovered y when inside the plot band", () => {
    expect(horizontalGuideRect(200, viewBox)).toEqual({ left: 60, top: 200, width: 900 });
  });

  it("returns a rect on the exact top and bottom edges of the band", () => {
    expect(horizontalGuideRect(40, viewBox)).toEqual({ left: 60, top: 40, width: 900 });
    expect(horizontalGuideRect(340, viewBox)).toEqual({ left: 60, top: 340, width: 900 });
  });

  it("returns null above the plot band", () => {
    expect(horizontalGuideRect(39, viewBox)).toBeNull();
  });

  it("returns null below the plot band", () => {
    expect(horizontalGuideRect(341, viewBox)).toBeNull();
  });

  it("returns null when y is unknown or non-finite", () => {
    expect(horizontalGuideRect(undefined, viewBox)).toBeNull();
    expect(horizontalGuideRect(Number.NaN, viewBox)).toBeNull();
  });

  it("defaults missing viewBox fields to 0 (band collapses to y === 0)", () => {
    expect(horizontalGuideRect(0, {})).toEqual({ left: 0, top: 0, width: 0 });
    expect(horizontalGuideRect(1, {})).toBeNull();
  });
});
