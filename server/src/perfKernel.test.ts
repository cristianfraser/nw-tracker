import { describe, expect, it } from "vitest";
import { cardPeriodLegs, compound, growthFactor, periodPl, runningGrowth, windowIndexOf } from "./perfKernel.js";

describe("periodPl", () => {
  it("an asset gains what it grew beyond its flows", () => {
    expect(periodPl({ valueStart: 100, valueEnd: 130, flow: 20, side: "asset" })).toBe(10);
  });
  it("a debt that fell less than it was paid is a cost", () => {
    // Owed 1000 → 950 after paying 70: 20 of the payment went to interest.
    expect(periodPl({ valueStart: 1000, valueEnd: 950, flow: 70, side: "debt" })).toBe(-20);
  });
});

describe("cardPeriodLegs", () => {
  it("the cost is the P/L and every other move of the owed balance is flow", () => {
    const legs = cardPeriodLegs({ owedStart: 500, owedEnd: 800, cost: 12 });
    expect(legs).toEqual({ flow: -288, pl: -12 });
    // The debt rule on the same legs gives back −cost.
    expect(periodPl({ valueStart: 500, valueEnd: 800, flow: legs.flow, side: "debt" })).toBe(-12);
  });
});

describe("windowIndexOf", () => {
  const b = ["2026-01-31", "2026-02-28", "2026-03-31"];
  it("finds the half-open window (b[i], b[i+1]] a day falls in", () => {
    expect(windowIndexOf(b, "2026-02-01")).toBe(0);
    expect(windowIndexOf(b, "2026-02-28")).toBe(0);
    expect(windowIndexOf(b, "2026-03-01")).toBe(1);
    expect(windowIndexOf(b, "2026-03-31")).toBe(1);
  });
  it("is −1 outside every window, the first boundary itself included", () => {
    expect(windowIndexOf(b, "2026-01-31")).toBe(-1);
    expect(windowIndexOf(b, "2026-04-01")).toBe(-1);
    expect(windowIndexOf(["2026-01-31"], "2026-02-01")).toBe(-1);
  });
});

describe("compounding", () => {
  it("chains the finite returns and skips missing ones", () => {
    expect(compound([0.1, null, -0.1])).toBeCloseTo(1.1 * 0.9 - 1, 15);
    expect(growthFactor([undefined, Number.NaN])).toEqual({ factor: 1, any: false });
    expect(compound([])).toBeNull();
  });
  it("keeps the running growth flat over a day with no return", () => {
    expect(runningGrowth([null, 0.5, null, 1])).toEqual([
      { factor: 1, any: false },
      { factor: 1.5, any: true },
      { factor: 1.5, any: true },
      { factor: 3, any: true },
    ]);
  });
});
