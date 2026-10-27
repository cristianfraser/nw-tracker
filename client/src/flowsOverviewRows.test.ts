import { describe, expect, it } from "vitest";
import { flowsOverviewRangeTotals, rollupFlowsOverviewRowsByYear } from "./flowsOverviewRows";
import type { FlowsOverviewRow } from "./types";

function row(
  period_month: string,
  legs: { income: number; expenses: number; deposits: number; pl?: number; card_spent?: number; card_paid?: number; cash_change: number }
): FlowsOverviewRow {
  const { income, expenses, deposits, pl = 0, card_spent = 0, card_paid = 0, cash_change } = legs;
  const savings = income - expenses;
  return {
    period_month,
    as_of_date: `${period_month}-28`,
    income,
    expenses,
    savings,
    deposits,
    deposits_pre_tax: 10,
    card_spent,
    card_paid,
    card_net: card_spent - card_paid,
    cash_change,
    cash_unexplained: cash_change - (savings - deposits + card_spent - card_paid),
    pl,
    investments_change: deposits + 10 + pl,
    net_worth_change: savings + 10 + pl,
  };
}

describe("flows overview rows", () => {
  const months = [
    row("2023-12", { income: 100, expenses: 40, deposits: 10, pl: 5, cash_change: 50 }),
    row("2024-01", { income: 200, expenses: 50, deposits: 20, pl: -3, card_spent: 30, cash_change: 160 }),
    row("2024-02", { income: 300, expenses: 60, deposits: 30, pl: 7, card_paid: 30, cash_change: 175 }),
  ];

  it("rolls months up into calendar years, summing the legs and re-deriving the rest", () => {
    const years = rollupFlowsOverviewRowsByYear(months);
    expect(years.map((y) => y.period_month)).toEqual(["2023-12", "2024-12"]);
    expect(years[1]).toEqual({
      period_month: "2024-12",
      as_of_date: "2024-12-31",
      income: 500,
      expenses: 110,
      savings: 390,
      deposits: 50,
      deposits_pre_tax: 20,
      card_spent: 30,
      card_paid: 30,
      card_net: 0,
      cash_change: 335,
      // 335 − (390 − 50 + 30 − 30)
      cash_unexplained: -5,
      pl: 4,
      investments_change: 74,
      net_worth_change: 414,
    });
    // The year's derived fields equal the sums of its months'.
    const sum = (k: keyof FlowsOverviewRow) => months.slice(1).reduce((s, r) => s + (r[k] as number), 0);
    expect(years[1]!.cash_unexplained).toBe(sum("cash_unexplained"));
    expect(years[1]!.net_worth_change).toBe(sum("net_worth_change"));
    // The input rows are not mutated.
    expect(months[1]!.income).toBe(200);
  });

  it("range totals add the kept rows and re-derive the derived fields", () => {
    const t = flowsOverviewRangeTotals(months.slice(1));
    const { period_month: _p, as_of_date: _a, ...year } = rollupFlowsOverviewRowsByYear(months.slice(1))[0]!;
    expect(t).toEqual(year);
  });
});
