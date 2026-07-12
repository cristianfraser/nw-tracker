import { describe, expect, it } from "vitest";
import {
  buildRealEstateExpensesPayload,
  mortgageCuotaBillMonths,
} from "./flowsRealEstateExpenses.js";

describe("mortgageCuotaBillMonths", () => {
  it("maps on-schedule cuotas to their payment month", () => {
    expect(
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "6", occurred_on: "2024-08-11" },
        { cuota: "7", occurred_on: "2024-09-12" },
      ])
    ).toEqual(["2024-07", "2024-08", "2024-09"]);
  });

  it("skip-then-double-payment lands the late cuota in its scheduled month", () => {
    // Real-world shape: Jan skipped, both cuotas paid in Feb.
    expect(
      mortgageCuotaBillMonths([
        { cuota: "10", occurred_on: "2024-12-11" },
        { cuota: "11", occurred_on: "2025-02-10" },
        { cuota: "12", occurred_on: "2025-02-11" },
        { cuota: "13", occurred_on: "2025-03-11" },
      ])
    ).toEqual(["2024-12", "2025-01", "2025-02", "2025-03"]);
  });

  it("late same-month payment (after the 11th) stays in its scheduled month", () => {
    expect(
      mortgageCuotaBillMonths([
        { cuota: "20", occurred_on: "2025-10-11" },
        { cuota: "21", occurred_on: "2025-11-25" },
        { cuota: "22", occurred_on: "2025-12-11" },
      ])
    ).toEqual(["2025-10", "2025-11", "2025-12"]);
  });

  it("anchor vote tie resolves to the smaller anchor (payments run late, never early)", () => {
    expect(
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "6", occurred_on: "2024-09-05" },
      ])
    ).toEqual(["2024-07", "2024-08"]);
  });

  it("empty ledger yields no months", () => {
    expect(mortgageCuotaBillMonths([])).toEqual([]);
  });

  it("throws on non-numeric cuota", () => {
    expect(() =>
      mortgageCuotaBillMonths([{ cuota: "pie", occurred_on: "2024-02-27" }])
    ).toThrow(/non-numeric/);
  });

  it("throws on duplicate cuota numbers", () => {
    expect(() =>
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "5", occurred_on: "2024-08-11" },
        { cuota: "6", occurred_on: "2024-08-12" },
      ])
    ).toThrow(/duplicate scheduled month/);
  });

  it("throws when a payment is months off its schedule", () => {
    expect(() =>
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "6", occurred_on: "2024-08-11" },
        { cuota: "7", occurred_on: "2024-09-11" },
        { cuota: "8", occurred_on: "2025-04-11" },
      ])
    ).toThrow(/off its scheduled month/);
  });
});

describe("buildRealEstateExpensesPayload", () => {
  it("returns slots with bill_month", () => {
    const payload = buildRealEstateExpensesPayload();
    for (const slot of payload.slots) {
      expect(slot.bill_month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof slot.can_link).toBe("boolean");
    }
  });

  it("total_clp matches sum of slot display amounts", () => {
    const payload = buildRealEstateExpensesPayload();
    const sum = payload.slots.reduce((s, sl) => s + sl.display_amount_clp, 0);
    expect(payload.total_clp).toBe(sum);
  });
});
