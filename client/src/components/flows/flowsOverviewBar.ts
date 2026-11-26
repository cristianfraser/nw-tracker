import type { FlowsOverviewTotals } from "../../types";
import type { FlowsOverviewSeries } from "./flowsOverviewColors";

export type FlowsOverviewBarSegment = { series: Exclude<FlowsOverviewSeries, "income">; amount: number };

/**
 * A period's bar around zero, as the «Flows and P/L» chart stacks it: expenses below the axis (left),
 * deposits and P/L above it (right), each on the other side when its sign is the other one. Segments
 * run outward from zero; amounts are sizes (positive). Income is the chart's line: a mark on the
 * right side, drawn only while it is positive (a month of net reversed income shows none).
 */
export function flowsOverviewBar(row: FlowsOverviewTotals): {
  left: FlowsOverviewBarSegment[];
  right: FlowsOverviewBarSegment[];
  income: number;
} {
  const left: FlowsOverviewBarSegment[] = [];
  const right: FlowsOverviewBarSegment[] = [];
  const put = (series: FlowsOverviewBarSegment["series"], signed: number) => {
    if (signed < 0) left.push({ series, amount: -signed });
    else if (signed > 0) right.push({ series, amount: signed });
  };
  put("expenses", -row.expenses);
  put("deposits", row.deposits);
  put("pl", row.pl);
  return { left, right, income: row.income };
}

/** How far a period's bar reaches from zero on its longer side (its income mark included). */
export function flowsOverviewBarExtent(row: FlowsOverviewTotals): number {
  const bar = flowsOverviewBar(row);
  const sum = (list: readonly FlowsOverviewBarSegment[]) => list.reduce((acc, s) => acc + s.amount, 0);
  return Math.max(sum(bar.left), sum(bar.right), bar.income, 0);
}
