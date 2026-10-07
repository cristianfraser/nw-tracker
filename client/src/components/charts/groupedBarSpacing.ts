/** Space between the bars of one category, in pixels. */
export const GROUPED_BAR_GAP_PX = 2;

/**
 * Smallest space kept on each side of a category's bar group, as a fraction of the category's
 * width — so neighbouring groups sit at least 30% of a category apart, well clear of
 * {@link GROUPED_BAR_GAP_PX}.
 */
const MIN_CATEGORY_SIDE_FRACTION = 0.15;

export type GroupedBarSpacingInput = {
  /** Chart width in pixels (what ResponsiveContainer measured). */
  chartWidth: number;
  marginLeft: number;
  marginRight: number;
  /** Width of the Y axis gutter, which takes plot width away. */
  yAxisWidth: number;
  categoryCount: number;
  /** Side-by-side bars per category. */
  barCount: number;
  /** The bars' own `maxBarSize`. */
  maxBarSize: number;
};

/**
 * Recharts `barGap` / `barCategoryGap` (both in pixels) that keep a category's bars together with
 * {@link GROUPED_BAR_GAP_PX} between them and put the rest of the category's width outside the
 * group.
 *
 * Recharts' defaults (4 px between bars, 10% of the category on each side) make the gap inside a
 * group about the same as the gap between groups on dense charts, and once `maxBarSize` caps the
 * bars it centres each bar in its own slot, so a wide category splits its pair apart. Here the
 * category gap is sized from the capped bar width, which leaves Recharts' slot equal to the bar.
 *
 * The plot width is the chart width less the margins and the Y axis gutter; an error there only
 * moves the group off centre by a few pixels, never apart.
 */
export function groupedBarSpacing(input: GroupedBarSpacingInput): {
  barGap: number;
  barCategoryGap: number;
} | null {
  const { chartWidth, marginLeft, marginRight, yAxisWidth, categoryCount, barCount, maxBarSize } =
    input;
  if (!(chartWidth > 0) || categoryCount < 1 || barCount < 2) return null;
  const plotWidth = chartWidth - marginLeft - marginRight - yAxisWidth;
  if (!(plotWidth > 0)) return null;
  const band = plotWidth / categoryCount;
  const gaps = (barCount - 1) * GROUPED_BAR_GAP_PX;
  const roomForBars = band * (1 - 2 * MIN_CATEGORY_SIDE_FRACTION) - gaps;
  // Recharts floors a bar width above 1 px; flooring here keeps its slot equal to our bar.
  const bar = Math.min(maxBarSize, Math.floor(roomForBars / barCount));
  if (bar < 1) {
    // Too dense for a gap inside the group: bars touch, the group keeps its side margins.
    return { barGap: 0, barCategoryGap: band * MIN_CATEGORY_SIDE_FRACTION };
  }
  // A hair under the exact side, so float error can't make Recharts floor its slot below `bar`.
  return {
    barGap: GROUPED_BAR_GAP_PX,
    barCategoryGap: (band - barCount * bar - gaps) / 2 - 0.01,
  };
}
