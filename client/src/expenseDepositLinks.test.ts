import { describe, expect, it } from "vitest";
import {
  BILLS_CC_EXPENSE_SLUG,
  REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
} from "./ccExpenseLineBuckets";
import { expenseCategoryChartPointTotal } from "./expenseDepositLinks";

describe("expense chart point total", () => {
  it("expenseCategoryChartPointTotal treats amortization as positive spend", () => {
    const pt = {
      as_of_date: "2024-03-31",
      [BILLS_CC_EXPENSE_SLUG]: 400_000,
      [REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]: -600_000,
    };
    expect(
      expenseCategoryChartPointTotal(pt, [
        BILLS_CC_EXPENSE_SLUG,
        REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG,
      ])
    ).toBe(1_000_000);
  });
});
