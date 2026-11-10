import { describe, expect, it } from "vitest";
import {
  isWheelSaleMonth,
  pickWheelUnderlying,
  planWheelTrade,
  thirdFriday,
  wheelExpiry,
  wheelOutcome,
  wheelStrike,
} from "./optionsWheel.js";
import type { OptionsWheel } from "./person.js";

const W: OptionsWheel = { from: "2025-01", everyMonths: 3, tradeDay: 15, otmPct: 5, targetDays: 45, premiumPctOfStrikePerDay: 0.04, strikeStep: 1 };
const weekday = (d: string) => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};

describe("options wheel rules", () => {
  it("finds third Fridays", () => {
    expect(thirdFriday("2025-02")).toBe("2025-02-21");
    expect(thirdFriday("2025-03")).toBe("2025-03-21");
    expect(thirdFriday("2025-08")).toBe("2025-08-15");
  });
  it("expires on the third Friday nearest 45 days out, the Thursday when Friday is closed", () => {
    expect(wheelExpiry("2025-01-15", 45, weekday)).toBe("2025-02-21");
    expect(wheelExpiry("2025-04-15", 45, weekday)).toBe("2025-05-16");
    // Good Friday 2025-04-18 closed: a contract whose third Friday it is expires the Thursday.
    expect(wheelExpiry("2025-03-03", 45, (d) => weekday(d) && d !== "2025-04-18")).toBe("2025-04-17");
  });
  it("sells every third month from the first", () => {
    expect([1, 2, 3, 4, 7, 10].map((m) => isWheelSaleMonth(W, `2025-${String(m).padStart(2, "0")}`))).toEqual([true, false, false, true, true, true]);
    expect(isWheelSaleMonth(W, "2024-10")).toBe(false);
  });
  it("puts below and calls above the close, never into the money", () => {
    expect(wheelStrike(143.29, "P", 5, 1)).toBe(136);
    expect(wheelStrike(143.29, "C", 5, 1)).toBe(151);
    expect(wheelStrike(100, "P", 5, 1)).toBe(95);
  });
  it("assigns a put below the strike and a call above it, nothing at the strike", () => {
    expect(wheelOutcome("P", 136, 135.99)).toBe("assigned");
    expect(wheelOutcome("P", 136, 136)).toBe("expired");
    expect(wheelOutcome("C", 151, 151.01)).toBe("assigned");
    expect(wheelOutcome("C", 151, 150)).toBe("expired");
  });
  it("plans a put with no shares and a covered call with 100", () => {
    const put = planWheelTrade(W, "2025-01-15", 143.29, 0, weekday);
    expect(put).toMatchObject({ right: "P", strike: 136, expiry: "2025-02-21" });
    expect(put.premiumPerShare).toBeCloseTo(136 * 0.0004 * 37, 2);
    expect(planWheelTrade(W, "2025-04-15", 150, 100, weekday)).toMatchObject({ right: "C", strike: 158, expiry: "2025-05-16" });
  });
  it("picks the largest candidate whose 100 shares fit the collateral", () => {
    const c = [
      { ticker: "A", close: 96.44 },
      { ticker: "B", close: 143.29 },
      { ticker: "C", close: 216.98 },
    ];
    expect(pickWheelUnderlying(c, 15_000).ticker).toBe("B");
    expect(() => pickWheelUnderlying(c, 5_000)).toThrow(/no candidate/);
  });
});
