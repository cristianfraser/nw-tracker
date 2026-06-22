import { describe, expect, it } from "vitest";
import { clpToUsdAtDate, expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";

describe("flowMoneyAtDate", () => {
  it("expenseGastosAmountUsdAtDate prefers native USD", () => {
    expect(expenseGastosAmountUsdAtDate(100_000, 120, "2025-03-15")).toBe(120);
  });
});

describe("clpToUsdAtDate", () => {
  it("returns 0 for zero CLP", () => {
    expect(clpToUsdAtDate(0, "2025-01-01")).toBe(0);
  });
});
