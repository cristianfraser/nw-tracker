import { describe, expect, it } from "vitest";
import {
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./ccExpenseLineBuckets";
import { expenseCategoryChartPointTotal } from "./expenseDepositLinks";

describe("expense chart point total", () => {
  it("expenseCategoryChartPointTotal treats amortization as positive spend", () => {
    const pt = {
      as_of_date: "2024-03-31",
      bills: 400_000,
      [REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]: -600_000,
    };
    expect(
      expenseCategoryChartPointTotal(pt, [
        "bills",
        REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
      ])
    ).toBe(1_000_000);
  });
});
