/** The flows overview's four series, one colour each: the «Flows and P/L» chart and the period rows. */
export const FLOWS_OVERVIEW_COLORS = {
  income: "#22c55e",
  expenses: "#ef4444",
  deposits: "#3b82f6",
  pl: "#60a5fa",
} as const;

export type FlowsOverviewSeries = keyof typeof FLOWS_OVERVIEW_COLORS;

/** The series in the order the chart's legend and a row's amounts list them. */
export const FLOWS_OVERVIEW_SERIES: readonly FlowsOverviewSeries[] = ["income", "expenses", "deposits", "pl"];
