import type { ComponentProps, ReactNode } from "react";
import { CartesianGrid, ComposedChart, Customized, ResponsiveContainer } from "recharts";
import { AlternatingXBands } from "./chartBands";
import { hasBandableBarGroups } from "./chartBandEdges";
import { RECHARTS_MONEY_CHART_MARGIN } from "./chartLayout";
import { appTooltipElement, type AppTooltipSpec } from "./ChartTooltip";
import { groupedBarSpacing } from "./groupedBarSpacing";

/** Side-by-side bars drawn per category, and what the wrapper needs to space them. */
export type AppBarGroup = {
  /** Bars actually drawn per category (hidden series excluded). */
  count: number;
  /** The bars' own `maxBarSize`. */
  maxBarSize: number;
  /** The Y axis gutter width (`rechartsMoneyYAxisWidth`), which takes plot width away. */
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
 * App wrapper around Recharts {@link ComposedChart}: owns the ResponsiveContainer, default margin, the
 * grid and the docked tooltip. Series/axes/legend stay composable as children; `stackOffset` etc. pass through.
 */
export function AppComposedChart(props: AppComposedChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* ResponsiveContainer passes the measured width/height to its child; the name must end in
          "Chart" for it to pass the sizing style too. */}
      <SizedAppComposedChart {...props} />
    </ResponsiveContainer>
  );
}

function SizedAppComposedChart({
  tooltip,
  margin,
  barGroup,
  grid = true,
  children,
  ...rest
}: AppComposedChartProps) {
  const gridProps = grid === false ? null : grid === true ? {} : grid;
  const chartMargin = margin ?? RECHARTS_MONEY_CHART_MARGIN;
  const categoryCount = rest.data?.length ?? 0;
  const groupedBars = barGroup != null && hasBandableBarGroups(barGroup.count, categoryCount);
  const spacing =
    barGroup && groupedBars && rest.width != null
      ? groupedBarSpacing({
          chartWidth: rest.width,
          marginLeft: chartMargin.left ?? 0,
          marginRight: chartMargin.right ?? 0,
          yAxisWidth: barGroup.yAxisWidth,
          categoryCount,
          barCount: barGroup.count,
          maxBarSize: barGroup.maxBarSize,
        })
      : null;
  return (
    <ComposedChart margin={chartMargin} {...spacing} {...rest}>
      {/* First, so the bands paint under the grid and every series. */}
      {groupedBars ? <Customized component={AlternatingXBands} /> : null}
      {gridProps ? (
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="#334155"
          opacity={0.35}
          vertical={!groupedBars}
          {...gridProps}
        />
      ) : null}
      {tooltip ? appTooltipElement(tooltip) : null}
      {children}
    </ComposedChart>
  );
}
