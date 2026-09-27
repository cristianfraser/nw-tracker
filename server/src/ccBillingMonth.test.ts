import { describe, expect, it } from "vitest";
import { billingMonthForCcStatement } from "./ccBillingMonth.js";

describe("billingMonthForCcStatement", () => {
  it("uses period_to month for Mar–Apr cycle (April facturación)", () => {
    expect(
      billingMonthForCcStatement({
        statement_date: "22/04/2026",
        period_to: "20/04/2026",
      })
    ).toBe("2026-04");
  });

  it("falls back to statement close when period_to is missing", () => {
    expect(
      billingMonthForCcStatement({
        statement_date: "24/05/2023",
        period_to: null,
      })
    ).toBe("2023-05");
  });
});
