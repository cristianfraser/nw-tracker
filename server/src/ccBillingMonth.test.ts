import { describe, expect, it } from "vitest";
import { billingMonthForPurchaseDate } from "./ccBillingMonth.js";

const SANTANDER_CYCLE = { billing_cycle_start_day: 21, billing_cycle_end_day: 20 };

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
