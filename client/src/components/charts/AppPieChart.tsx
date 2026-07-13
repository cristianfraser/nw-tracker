import type { ComponentProps, ReactNode } from "react";
import { PieChart, ResponsiveContainer } from "recharts";
import { appTooltipElement, type AppTooltipSpec } from "./ChartTooltip";

/** Room for slice value labels above the pie (matches the legacy AllocationPiePanel margin). */
const PIE_CHART_MARGIN = { top: 32, right: 4, left: 4, bottom: 0 } as const;

export type AppPieChartProps = ComponentProps<typeof PieChart> & {
  /** Docked collision-aware tooltip (see {@link AppTooltipSpec}). Omit for no tooltip. */
  tooltip?: AppTooltipSpec | null;
  children: ReactNode;
};

/**
 * App wrapper around Recharts {@link PieChart}: owns the ResponsiveContainer, default margin, and the docked
 * tooltip. `<Pie>`/`<Cell>`/`<Legend>` stay composable as children.
 */
export function AppPieChart({ tooltip, margin, children, ...rest }: AppPieChartProps) {
  // A mouse-y crosshair is meaningless on a pie (centric layout — `coordinate` is a polar conversion).
  const pieTooltip = tooltip ? { ...tooltip, horizontalGuide: false } : tooltip;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={margin ?? PIE_CHART_MARGIN} {...rest}>
        {pieTooltip ? appTooltipElement(pieTooltip) : null}
        {children}
      </PieChart>
    </ResponsiveContainer>
  );
}
