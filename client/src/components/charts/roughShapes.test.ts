import { describe, expect, it } from "vitest";
import type { Point } from "roughjs/bin/geometry";
import { CHART_STYLES } from "../../chartStylePreference";
import { inkCoverage, roughPenFor } from "./roughShapes";

/**
 * The hand-drawn pens may lighten a line (fades, the other passes thinned over a dry skip) but
 * must never leave it empty: inside the line, every stretch without full main-pass ink longer than
 * 3 px has to be covered by a repair scribble. A user saw a ~20 px hole in a pen line on the
 * dashboard. The line's true start and end may fade out on purpose, no longer than the pen's
 * longest fade.
 */

/** A deterministic walk: `n` points across `width` px, values in a 300 px tall plot. */
function walk(n: number, width: number, seed: number): Point[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  let y = 150;
  return Array.from({ length: n }, (_, i): Point => {
    y = Math.max(10, Math.min(290, y + (rnd() - 0.5) * (n > 100 ? 6 : 60)));
    return [20 + (i * width) / Math.max(1, n - 1), y];
  });
}

const PENS = CHART_STYLES.filter((s) => s !== "plain");
const LINES: [string, Point[]][] = [
  ["12-point monthly", walk(12, 1350, 7)],
  ["1.096-point daily", walk(1096, 1425, 11)],
];
const MAX_GAP_PX = 3;

describe("hand-drawn pens leave no gaps", () => {
  it("covers every pen type", () => {
    expect(PENS).toEqual(["pen", "pencil", "marker", "watercolor", "crayon"]);
  });

  for (const style of PENS) {
    for (const [label, line] of LINES) {
      it(`${style}: ${label} line, 50 seeds, no interior stretch over ${MAX_GAP_PX} px without full ink`, () => {
        const pen = roughPenFor(style)!;
        let interior = 0;
        let ends = 0;
        for (let seed = 1; seed <= 50; seed++) {
          const c = inkCoverage([line], pen, seed * 104729, 1.5);
          interior = Math.max(interior, c.longestInteriorGapPx);
          ends = Math.max(ends, c.longestEndGapPx);
        }
        expect(interior).toBeLessThanOrEqual(MAX_GAP_PX);
        expect(ends).toBeLessThanOrEqual(pen.ends.fadeLengthPx[1] + 1);
      });
    }
  }

  it("a null in the data is the only break: two runs are checked apart", () => {
    const pen = roughPenFor("pen")!;
    const [a, b] = [walk(6, 600, 3), walk(6, 600, 5).map(([x, y]): Point => [x + 700, y])];
    expect(inkCoverage([a, b], pen, 42, 1.5).longestInteriorGapPx).toBeLessThanOrEqual(MAX_GAP_PX);
  });
});
