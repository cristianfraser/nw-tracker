import type { FlowsOverviewTotals } from "../../types";
import { FLOWS_OVERVIEW_COLORS } from "./flowsOverviewColors";
import { zeroBarExtent, zeroBarSides, type ZeroBarSegment } from "./ZeroBar";

/**
 * A period's bar around zero, as the «Flows and P/L» chart stacks it: expenses below the axis (left),
 * deposits and P/L above it (right), each on the other side when its sign is the other one, in the
 * chart's colours (`zeroBarSides`). Income is the chart's line: a mark on the right side, drawn
 * only while it is positive (a month of net reversed income shows none).
 */
export function flowsOverviewBar(row: FlowsOverviewTotals): {
  left: ZeroBarSegment[];
  right: ZeroBarSegment[];
  income: number;
} {
  const sides = zeroBarSides([
    { key: "expenses", color: FLOWS_OVERVIEW_COLORS.expenses, value: -row.expenses },
    { key: "deposits", color: FLOWS_OVERVIEW_COLORS.deposits, value: row.deposits },
    { key: "pl", color: FLOWS_OVERVIEW_COLORS.pl, value: row.pl },
  ]);
  return { ...sides, income: row.income };
}

/** How far a period's bar reaches from zero on its longer side (its income mark included). */
export function flowsOverviewBarExtent(row: FlowsOverviewTotals): number {
  const bar = flowsOverviewBar(row);
  return zeroBarExtent(bar, Math.max(bar.income, 0));
}
