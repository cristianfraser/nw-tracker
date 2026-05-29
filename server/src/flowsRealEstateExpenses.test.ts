import { describe, expect, it } from "vitest";
import { buildRealEstateExpensesPayload } from "./flowsRealEstateExpenses.js";

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
