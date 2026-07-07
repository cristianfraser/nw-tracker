import type { ComponentProps, ReactNode } from "react";
import { ComposedChart, ResponsiveContainer } from "recharts";
import { RECHARTS_MONEY_CHART_MARGIN } from "./chartLayout";
import { appTooltipElement, type AppTooltipSpec } from "./ChartTooltip";

export type AppComposedChartProps = ComponentProps<typeof ComposedChart> & {
  /** Docked collision-aware tooltip (see {@link AppTooltipSpec}). Omit for no tooltip. */
  tooltip?: AppTooltipSpec | null;
  children: ReactNode;
};

/**
 * App wrapper around Recharts {@link ComposedChart}: owns the ResponsiveContainer, default margin, and the
 * docked tooltip. Series/axes/legend stay composable as children; `stackOffset` etc. pass through.
 */
export function AppComposedChart({ tooltip, margin, children, ...rest }: AppComposedChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart margin={margin ?? RECHARTS_MONEY_CHART_MARGIN} {...rest}>
        {tooltip ? appTooltipElement(tooltip) : null}
        {children}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
