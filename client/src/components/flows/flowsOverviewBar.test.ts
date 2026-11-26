import { describe, expect, it } from "vitest";
import { ZERO_FLOWS_OVERVIEW_TOTALS } from "../../flowsOverviewRows";
import { flowsOverviewBar, flowsOverviewBarExtent } from "./flowsOverviewBar";

const row = (p: Partial<typeof ZERO_FLOWS_OVERVIEW_TOTALS>) => ({ ...ZERO_FLOWS_OVERVIEW_TOTALS, ...p });

describe("flowsOverviewBar", () => {
  it("puts expenses left of zero and positive deposits and P/L right of it", () => {
    const bar = flowsOverviewBar(row({ income: 100, expenses: 60, deposits: 30, pl: 20 }));
    expect(bar.left).toEqual([{ series: "expenses", amount: 60 }]);
    expect(bar.right).toEqual([
      { series: "deposits", amount: 30 },
      { series: "pl", amount: 20 },
    ]);
    expect(bar.income).toBe(100);
  });

  it("moves a withdrawal and a loss to the left, after expenses", () => {
    const bar = flowsOverviewBar(row({ expenses: 60, deposits: -30, pl: -20 }));
    expect(bar.left).toEqual([
      { series: "expenses", amount: 60 },
      { series: "deposits", amount: 30 },
      { series: "pl", amount: 20 },
    ]);
    expect(bar.right).toEqual([]);
  });

  it("puts a month of net refunds right of zero and leaves zero figures out", () => {
    const bar = flowsOverviewBar(row({ expenses: -15 }));
    expect(bar.left).toEqual([]);
    expect(bar.right).toEqual([{ series: "expenses", amount: 15 }]);
  });

  it("reaches as far as its longer side or its income", () => {
    expect(flowsOverviewBarExtent(row({ income: 100, expenses: 60, deposits: 30, pl: 20 }))).toBe(100);
    expect(flowsOverviewBarExtent(row({ income: 10, expenses: 60, deposits: -30, pl: 5 }))).toBe(90);
    expect(flowsOverviewBarExtent(row({}))).toBe(0);
  });
});
