import { describe, expect, it } from "vitest";
import { rollupIncomeChartPointsByYear, rollupIncomeMonthRowsByYear } from "./incomeAggregates";
import { sumChartPointsField } from "./flowsDisplay";
import { clipMonthsThenRollup } from "./timeRange";
import type { FlowIncomeChartPoint, FlowIncomeMonthRow } from "./types";

/** Server month rows (`buildFlowsIncomeAggregates`), oldest first. */
function monthRow(period_month: string, salary: number, other = 0): FlowIncomeMonthRow {
  const [y, m] = period_month.split("-").map(Number);
  const as_of_date = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  return {
    period_month,
    as_of_date,
    salary_clp: salary,
    severance_clp: 0,
    parent_gift_clp: 0,
    other_clp: other,
    total_clp: salary + other,
    line_count: (salary ? 1 : 0) + (other ? 1 : 0),
    cumulative_clp: 0,
  };
}

function chartPoint(r: FlowIncomeMonthRow): FlowIncomeChartPoint {
  return {
    as_of_date: r.as_of_date,
    salary: r.salary_clp,
    severance: r.severance_clp,
    parent_gift: r.parent_gift_clp,
    other: r.other_clp,
    total: r.total_clp,
  };
}

const MONTHS = [
  monthRow("2023-03", 1_000_000),
  monthRow("2023-08", 0, 200_000),
  monthRow("2023-10", 1_100_000),
  monthRow("2023-12", 0, 50_000),
  monthRow("2024-05", 1_200_000),
  monthRow("2026-02", 1_300_000),
];

describe("rollupIncomeMonthRowsByYear", () => {
  it("sums each year's months and runs the cumulative over the years", () => {
    const years = rollupIncomeMonthRowsByYear(MONTHS);
    expect(years.map((y) => [y.period_month, y.total_clp, y.line_count, y.cumulative_clp])).toEqual([
      ["2023-12", 2_350_000, 4, 2_350_000],
      ["2024-12", 1_200_000, 1, 3_550_000],
      ["2026-12", 1_300_000, 1, 4_850_000],
    ]);
  });
});

describe("income chart under a Rango", () => {
  // 3y back from 2026-09-26: September 2023 (month-end 09-30) is the first month in.
  const TODAY = "2026-09-26";
  const points = MONTHS.map(chartPoint);

  it("gives a partial first year: the sum of that year's months inside the range", () => {
    const years = clipMonthsThenRollup(points, "year", "3y", rollupIncomeChartPointsByYear, TODAY);
    expect(years.map((p) => p.as_of_date)).toEqual(["2023-12-31", "2024-12-31", "2026-12-31"]);
    // Only Oct + Dec 2023 are inside the range; March and August stay out.
    expect(years[0]).toEqual({
      as_of_date: "2023-12-31",
      salary: 1_100_000,
      severance: 0,
      parent_gift: 0,
      other: 50_000,
      total: 1_150_000,
    });
    const months = clipMonthsThenRollup(points, "month", "3y", rollupIncomeChartPointsByYear, TODAY);
    const monthsOf2023 = months.filter((p) => p.as_of_date.startsWith("2023-"));
    expect(monthsOf2023.map((p) => p.as_of_date)).toEqual(["2023-10-31", "2023-12-31"]);
    expect(years[0]!.total).toBe(sumChartPointsField(monthsOf2023, "total"));
    // «En el rango» reads the same at year and month grain.
    expect(sumChartPointsField(years, "total")).toBe(sumChartPointsField(months, "total"));
    expect(sumChartPointsField(years, "total")).toBe(1_150_000 + 1_200_000 + 1_300_000);
  });
});
