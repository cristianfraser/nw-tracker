import { describe, expect, it } from "vitest";
import { billingMonthForCcStatement, billingMonthForPurchaseDate } from "./ccBillingMonth.js";

const SANTANDER_CYCLE = { billing_cycle_start_day: 21, billing_cycle_end_day: 20 };

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

describe("billingMonthForPurchaseDate", () => {
  it("maps Apr 25 purchase to May billing month (21→20 cycle)", () => {
    expect(billingMonthForPurchaseDate("2026-04-25", SANTANDER_CYCLE)).toBe("2026-05");
  });

  it("maps May 10 purchase to May billing month", () => {
    expect(billingMonthForPurchaseDate("2026-05-10", SANTANDER_CYCLE)).toBe("2026-05");
  });

  it("maps Mar 15 purchase to March billing month", () => {
    expect(billingMonthForPurchaseDate("2026-03-15", SANTANDER_CYCLE)).toBe("2026-03");
  });
});
