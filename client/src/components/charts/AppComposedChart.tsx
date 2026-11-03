import { useId, useMemo, type ComponentProps, type ReactNode } from "react";
import { CartesianGrid, ComposedChart } from "recharts";
import { AlternatingXBands } from "./chartBands";
import { hasBandableBarGroups } from "./chartBandEdges";
import { RECHARTS_MONEY_CHART_MARGIN } from "./chartLayout";
import { appTooltipElement, type AppTooltipSpec } from "./ChartTooltip";
import { groupedBarSpacing } from "./groupedBarSpacing";
import { useElementSize } from "./useElementSize";
import { useChartStyle } from "./chartStyle";
import {
  RoughAxisLines,
  RoughChartDefs,
  injectRoughShapes,
  roughAxisSides,
  roughGrainFilterId,
  roughGridProps,
  roughModeFor,
  roughSeed,
} from "./roughShapes";

/** Side-by-side bars drawn per category, and what the wrapper needs to space them. */
export type AppBarGroup = {
  /** Bars actually drawn per category (hidden series excluded). */
  count: number;
  /** The bars' own `maxBarSize`. */
  maxBarSize: number;
  /** The Y axis gutter width (`yAxisWidthForTicks`), which takes plot width away. */
  yAxisWidth: number;
};

export type AppComposedChartProps = ComponentProps<typeof ComposedChart> & {
  /** Docked collision-aware tooltip (see {@link AppTooltipSpec}). Omit for no tooltip. */
  tooltip?: AppTooltipSpec | null;
  /**
   * Side-by-side bars per category. With two or more (and more than one category) the wrapper:
   * - swaps the vertical grid lines — which sit on the ticks, i.e. straight through the middle of
   *   the group — for faint alternating bands that bracket each group;
   * - keeps a group's bars 2 px apart and puts the rest of the category's width between groups
   *   (`groupedBarSpacing`), unless the chart sets `barGap` / `barCategoryGap` itself.
   *
   * Per render, not per chart: the same component draws grouped bars in one mode and a single
   * consolidated bar in another, and one column per tick (single *or stacked*) needs neither.
   * Count the series that are actually drawn.
   */
  barGroup?: AppBarGroup | null;
  /** `false` to opt out of the shared grid; an object to override its props. */
  grid?: boolean | ComponentProps<typeof CartesianGrid>;
  children: ReactNode;
};

/**
 * App wrapper around Recharts {@link ComposedChart}: fills its box, owns the default margin, the
 * grid and the docked tooltip. Series/axes/legend stay composable as children; `stackOffset` etc. pass through.
 *
 * Measures its own box instead of using `ResponsiveContainer`: the grouped-bar spacing needs the
 * chart width, and v3's container only hands it to the chart through a private context.
 */
export function AppComposedChart(props: AppComposedChartProps) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  return (
    <div ref={ref} style={{ width: "100%", height: "100%" }}>
      {width > 0 && height > 0 ? <SizedAppComposedChart {...props} width={width} height={height} /> : null}
    </div>
  );
}

function SizedAppComposedChart({
  width,
  height,
  tooltip,
  margin,
  barGroup,
  grid = true,
  children,
  ...rest
}: AppComposedChartProps & { width: number; height: number }) {
  const gridProps = grid === false ? null : grid === true ? {} : grid;
  const rough = roughModeFor(useChartStyle());
  const grainFilterId = roughGrainFilterId(useId());
  // The hand-drawn chart styles (roughShapes.tsx): every series drawn by rough.js; `plain` never clones.
  const series = useMemo(
    () => (rough ? injectRoughShapes(children, rough, grainFilterId) : children),
    [children, rough, grainFilterId]
  );
  const axisSides = useMemo(() => (rough?.extras ? roughAxisSides(children) : []), [children, rough]);
  const chartMargin = margin ?? RECHARTS_MONEY_CHART_MARGIN;
  const categoryCount = rest.data?.length ?? 0;
  const groupedBars = barGroup != null && hasBandableBarGroups(barGroup.count, categoryCount);
  const spacing =
    barGroup && groupedBars
      ? groupedBarSpacing({
          chartWidth: width,
          marginLeft: chartMargin.left ?? 0,
          marginRight: chartMargin.right ?? 0,
          yAxisWidth: barGroup.yAxisWidth,
          categoryCount,
          barCount: barGroup.count,
          maxBarSize: barGroup.maxBarSize,
        })
      : null;
  return (
    <ComposedChart margin={chartMargin} {...spacing} {...rest} width={width} height={height}>
      {/* Its own layer under the grid and every series. */}
      {groupedBars ? <AlternatingXBands /> : null}
      {gridProps ? (
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="#334155"
          opacity={0.35}
          vertical={!groupedBars}
          {...gridProps}
          {...((rough?.extras
            ? roughGridProps({ vertical: !groupedBars, ...gridProps }, rough)
            : null) as Partial<ComponentProps<typeof CartesianGrid>> | null)}
        />
      ) : null}
      {tooltip ? appTooltipElement(tooltip) : null}
      {rough ? <RoughChartDefs mode={rough} grainFilterId={grainFilterId} /> : null}
      {series}
      {axisSides.length ? <RoughAxisLines sides={axisSides} seed={roughSeed("axis", rough?.seedSalt)} multiStroke={rough?.multiStrokeExtras ?? true} /> : null}
    </ComposedChart>
  );
}
