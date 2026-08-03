import type { ComponentProps, ReactNode } from "react";
import { CartesianGrid, ComposedChart, Customized, ResponsiveContainer } from "recharts";
import { AlternatingXBands } from "./chartBands";
import { RECHARTS_MONEY_CHART_MARGIN } from "./chartLayout";
import { appTooltipElement, type AppTooltipSpec } from "./ChartTooltip";

export type AppComposedChartProps = ComponentProps<typeof ComposedChart> & {
  /** Docked collision-aware tooltip (see {@link AppTooltipSpec}). Omit for no tooltip. */
  tooltip?: AppTooltipSpec | null;
  /**
   * True when a category carries two or more side-by-side bars. Swaps the vertical grid lines —
   * which sit on the ticks, i.e. straight through the middle of the group — for faint alternating
   * bands that bracket each group instead.
   *
   * Per render, not per chart: the same component draws grouped bars in one mode and a single
   * consolidated bar in another, and one column per tick (single *or stacked*) needs no bracketing.
   * Derive it from the series that are actually drawn, e.g. `barSeries.length > 1`.
   */
  groupedBars?: boolean;
  /** `false` to opt out of the shared grid; an object to override its props. */
  grid?: boolean | ComponentProps<typeof CartesianGrid>;
  children: ReactNode;
};

/**
 * App wrapper around Recharts {@link ComposedChart}: owns the ResponsiveContainer, default margin, the
 * grid and the docked tooltip. Series/axes/legend stay composable as children; `stackOffset` etc. pass through.
 */
export function AppComposedChart({
  tooltip,
  margin,
  groupedBars = false,
  grid = true,
  children,
  ...rest
}: AppComposedChartProps) {
  const gridProps = grid === false ? null : grid === true ? {} : grid;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart margin={margin ?? RECHARTS_MONEY_CHART_MARGIN} {...rest}>
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
    </ResponsiveContainer>
  );
}
