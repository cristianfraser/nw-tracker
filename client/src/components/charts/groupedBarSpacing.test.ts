import { describe, expect, it } from "vitest";
import { GROUPED_BAR_GAP_PX, groupedBarSpacing } from "./groupedBarSpacing";

const BASE = { chartWidth: 1000, marginLeft: 2, marginRight: 8, yAxisWidth: 90, maxBarSize: 28 };

/** Recharts' bar layout for unset `barSize` (`getBarPosition`), reduced to the bar boxes. */
function rechartsBars(band: number, n: number, gap: number, categoryGap: number, maxBarSize: number) {
  let realGap = gap;
  if (band - 2 * categoryGap - (n - 1) * realGap <= 0) realGap = 0;
  let original = (band - 2 * categoryGap - (n - 1) * realGap) / n;
  if (original > 1) original = Math.floor(original);
  const size = Math.min(original, maxBarSize);
  return Array.from({ length: n }, (_, i) => {
    const start = categoryGap + (original + realGap) * i + (original - size) / 2;
    return { start, end: start + size };
  });
}

function layout(categoryCount: number, barCount: number) {
  const spacing = groupedBarSpacing({ ...BASE, categoryCount, barCount });
  if (!spacing) throw new Error("no spacing");
  const band = (BASE.chartWidth - BASE.marginLeft - BASE.marginRight - BASE.yAxisWidth) / categoryCount;
  const bars = rechartsBars(band, barCount, spacing.barGap, spacing.barCategoryGap, BASE.maxBarSize);
  const inside = bars.slice(1).map((b, i) => b.start - bars[i]!.end);
  const between = band - bars[bars.length - 1]!.end + bars[0]!.start;
  return { bars, inside, between, band };
}

describe("groupedBarSpacing", () => {
  it("keeps a dense group's bars 2 px apart and the groups further apart", () => {
    const { inside, between, band } = layout(60, 2);
    for (const g of inside) expect(g).toBeCloseTo(GROUPED_BAR_GAP_PX, 1);
    expect(between).toBeGreaterThanOrEqual(band * 0.3 - 0.1);
  });

  it("keeps capped bars together on wide categories instead of spreading them", () => {
    const { bars, inside, between, band } = layout(6, 2);
    expect(bars[0]!.end - bars[0]!.start).toBeCloseTo(BASE.maxBarSize, 6);
    for (const g of inside) expect(g).toBeCloseTo(GROUPED_BAR_GAP_PX, 1);
    expect(between).toBeCloseTo(band - 2 * BASE.maxBarSize - GROUPED_BAR_GAP_PX, 1);
  });

  it("handles three or more bars per group", () => {
    const { inside } = layout(24, 4);
    expect(inside).toHaveLength(3);
    for (const g of inside) expect(g).toBeCloseTo(GROUPED_BAR_GAP_PX, 1);
  });

  it("lets bars touch when the category is too narrow for a gap", () => {
    expect(groupedBarSpacing({ ...BASE, categoryCount: 600, barCount: 2 })?.barGap).toBe(0);
  });

  it("returns nothing without a measured width or a real group", () => {
    expect(groupedBarSpacing({ ...BASE, chartWidth: 0, categoryCount: 12, barCount: 2 })).toBeNull();
    expect(groupedBarSpacing({ ...BASE, categoryCount: 12, barCount: 1 })).toBeNull();
  });
});
