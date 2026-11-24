import { formatFlowMoney, rollupChartPointsByYear } from "./flowsDisplay";
import type { DisplayUnit } from "./queries/keys";
import type { FlowIncomeChartPoint, FlowIncomeMonthRow } from "./types";

/*
 * Income page display helpers. The page's month rows, day points and total are built on the
 * server (`buildFlowsIncomeAggregates`, the overview's own income rule) and only picked here;
 * the yearly rollups below re-bucket those server rows by calendar year, the flows pages'
 * convention for M/Y views.
 */

/** An income figure in the payload's unit; one with no rate on file for its day reads «—». */
export function formatIncomeMoney(amount: number | null, unit: DisplayUnit): string {
  return amount == null ? "—" : formatFlowMoney(amount, unit);
}

export function rollupIncomeMonthRowsByYear(rows: readonly FlowIncomeMonthRow[]): FlowIncomeMonthRow[] {
  const byYear = new Map<string, Omit<FlowIncomeMonthRow, "cumulative" | "lines">>();
  for (const row of rows) {
    const year = row.period_month.slice(0, 4);
    const cur = byYear.get(year);
    if (!cur) {
      byYear.set(year, {
        period_month: `${year}-12`,
        as_of_date: `${year}-12-31`,
        salary: row.salary,
        severance: row.severance,
        parent_gift: row.parent_gift,
        rent: row.rent,
        other: row.other,
        total: row.total,
        line_count: row.line_count,
      });
      continue;
    }
    cur.salary += row.salary;
    cur.severance += row.severance;
    cur.parent_gift += row.parent_gift;
    cur.rent += row.rent;
    cur.other += row.other;
    cur.total += row.total;
    cur.line_count += row.line_count;
  }
  let running = 0;
  return [...byYear.keys()].sort().map((year) => {
    const row = byYear.get(year)!;
    running += row.total;
    // A year row opens into its months, which carry the lines.
    return { ...row, cumulative: running, lines: [] };
  });
}

const INCOME_CHART_KEYS = ["salary", "severance", "parent_gift", "rent", "other", "total"] as const;

/**
 * Yearly income chart rows from monthly ones (every kind is a flow: it sums). The chart feeds it
 * through `clipMonthsThenRollup`, so a Rango that starts mid-year gives a partial first year.
 */
export function rollupIncomeChartPointsByYear(
  points: readonly FlowIncomeChartPoint[]
): FlowIncomeChartPoint[] {
  return rollupChartPointsByYear(points, INCOME_CHART_KEYS);
}
