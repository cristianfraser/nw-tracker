import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlowsAmountFilter } from "./flowsAmountFilter";
import { setDecimalSeparatorForFormatting } from "./format";

// Amounts are read with the decimal-separator preference — pin it so tests don't depend on
// the machine timezone that seeds it.
beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

describe("parseFlowsAmountFilter", () => {
  it("reads plain numbers like every number field, as the |amount| they match", () => {
    expect(parseFlowsAmountFilter("1.325.724")).toEqual({ value: 1_325_724, error: null });
    expect(parseFlowsAmountFilter("-500")).toEqual({ value: 500, error: null });
    expect(parseFlowsAmountFilter("  ")).toEqual({ value: undefined, error: null });
  });

  it("takes an amount copied from the flows table with its currency symbol", () => {
    expect(parseFlowsAmountFilter("$1.325.724")).toEqual({ value: 1_325_724, error: null });
    expect(parseFlowsAmountFilter("$ 1.325.724")).toEqual({ value: 1_325_724, error: null });
    expect(parseFlowsAmountFilter("US$ 12,50")).toEqual({ value: 12.5, error: null });
    expect(parseFlowsAmountFilter("US$12,50")).toEqual({ value: 12.5, error: null });
    expect(parseFlowsAmountFilter("-$500")).toEqual({ value: 500, error: null });
    expect(parseFlowsAmountFilter("-US$ 3,5")).toEqual({ value: 3.5, error: null });
  });

  it("reads the number after the symbol with the separator setting", () => {
    expect(parseFlowsAmountFilter("$1.500").value).toBe(1500);
    setDecimalSeparatorForFormatting("period");
    expect(parseFlowsAmountFilter("$1.500").value).toBe(1.5);
    expect(parseFlowsAmountFilter("US$ 12.50").value).toBe(12.5);
    expect(parseFlowsAmountFilter("$1,325,724").value).toBe(1_325_724);
  });

  it("rejects anything else with the message naming the whole entry", () => {
    for (const raw of ["$$500", "$-500", "$ -500", "US$  5", "USD 5", "($500)", "5$", "$", "$1.50.000"]) {
      const result = parseFlowsAmountFilter(raw);
      expect(result.value, raw).toBeUndefined();
      expect(result.error, raw).toContain(raw);
    }
  });
});
