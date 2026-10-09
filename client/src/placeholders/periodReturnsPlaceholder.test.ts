import { describe, expect, it } from "vitest";
import { PERIOD_RETURN_KEYS, placeholderPeriodReturnsPayload } from "./periodReturnsPlaceholder";

describe("placeholderPeriodReturnsPayload", () => {
  it("lists every window in the server's fixed order", () => {
    const payload = placeholderPeriodReturnsPayload("clp");
    expect(payload.periods.map((c) => c.period)).toEqual([
      "d1",
      "w1",
      "mtd",
      "ytd",
      "y1",
      "y3",
      "y5",
      "total",
    ]);
    expect(PERIOD_RETURN_KEYS).toHaveLength(payload.periods.length);
  });

  it("carries no values: every cell is empty and the unit is the requested one", () => {
    const payload = placeholderPeriodReturnsPayload("usd");
    expect(payload.unit).toBe("usd");
    for (const cell of payload.periods) {
      expect(cell.pct).toBeNull();
      expect(cell.nominal_pl).toBeNull();
      expect(cell.annualized_pct).toBeNull();
      expect(cell.months).toBe(0);
      expect(cell.window_start_month).toBeNull();
      expect(cell.window_start_date).toBeNull();
    }
  });
});
