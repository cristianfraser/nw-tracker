import { describe, expect, it } from "vitest";
import { aggregateDepositChartPointsByDay } from "./flowsDepositsAggregate";
import { aggregateIncomeChartPointsByDay } from "./incomeAggregates";
import type { FlowDepositRow, FlowsIncomeResponse } from "./types";

function depositRow(
  occurred_on: string,
  category: FlowDepositRow["category"],
  amount_clp: number,
  amount_usd: number | null
): FlowDepositRow {
  return {
    occurred_on,
    category,
    category_label: category,
    account_id: 1,
    account_name: "acc",
    kind_slug: "cuenta_corriente",
    amount_clp,
    amount_usd,
  };
}

describe("aggregateDepositChartPointsByDay", () => {
  const rows: FlowDepositRow[] = [
    depositRow("2025-03-05", "cash", 100, 0.1),
    depositRow("2025-03-05", "brokerage", 50, 0.05),
    depositRow("2025-03-20", "cash", 30, 0.03),
    depositRow("2025-04-02", "inversiones", -20, -0.02),
  ];

  it("buckets events by exact day, one point per day with events", () => {
    const pts = aggregateDepositChartPointsByDay(rows, "clp");
    expect(pts.map((p) => p.as_of_date)).toEqual(["2025-03-05", "2025-03-20", "2025-04-02"]);
    const march5 = pts[0]!;
    expect(march5.cash).toBe(100);
    expect(march5.brokerage).toBe(50);
    expect(march5.total).toBe(150);
  });

  it("Σ(day totals in a month) reconciles to the month sum of the rows", () => {
    const pts = aggregateDepositChartPointsByDay(rows, "clp");
    const marchDays = pts.filter((p) => p.as_of_date.startsWith("2025-03"));
    const marchDaySum = marchDays.reduce((s, p) => s + p.total, 0);
    const marchRowSum = rows
      .filter((r) => r.occurred_on.startsWith("2025-03"))
      .reduce((s, r) => s + r.amount_clp, 0);
    expect(marchDaySum).toBe(marchRowSum); // 180
  });

  it("voids the USD series when a row is unconvertible (fail loud, not silent 0)", () => {
    const withNull = [...rows, depositRow("2025-05-01", "cash", 10, null)];
    expect(aggregateDepositChartPointsByDay(withNull, "usd")).toEqual([]);
  });
});

describe("aggregateIncomeChartPointsByDay", () => {
  const data: FlowsIncomeResponse = {
    lines: [
      {
        movement_id: 1,
        account_id: 1,
        account_label: "cta",
        received_on: "2025-06-10",
        amount_clp: 1000,
        amount_usd: 1,
        description: "sueldo",
        source: "checking",
      },
      {
        movement_id: 2,
        account_id: 1,
        account_label: "cta",
        received_on: "2025-06-10",
        amount_clp: 300,
        amount_usd: 0.3,
        description: "otro",
        source: "checking",
      },
    ],
    manual: [
      {
        id: 1,
        amount_clp: 200,
        received_on: "2025-06-15",
        amount_usd: 0.2,
        source: null,
        note: null,
        origin: "manual",
      },
    ],
    monthly_totals: {},
    work_earnings: [],
    income_kind_by_movement_id: { 1: "salary", 2: "other" },
    payroll_period_by_movement_id: {},
    excluded_lines: [],
    filtered_lines: [],
  };

  it("buckets income by the arrival day (not payroll-month attribution)", () => {
    const pts = aggregateIncomeChartPointsByDay(data, "clp");
    expect(pts.map((p) => p.as_of_date)).toEqual(["2025-06-10", "2025-06-15"]);
    const jun10 = pts[0]!;
    expect(jun10.salary).toBe(1000);
    expect(jun10.other).toBe(300);
    expect(jun10.total).toBe(1300);
    const jun15 = pts[1]!;
    expect(jun15.other).toBe(200);
  });

  it("Σ(day totals) equals Σ of all income amounts", () => {
    const pts = aggregateIncomeChartPointsByDay(data, "clp");
    const daySum = pts.reduce((s, p) => s + p.total, 0);
    expect(daySum).toBe(1000 + 300 + 200);
  });
});
