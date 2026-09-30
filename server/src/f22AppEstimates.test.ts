import { describe, expect, it } from "vitest";
import { mortgageInterestDeduction } from "./f22AppEstimates.js";

const UTA = 800_000;

describe("mortgageInterestDeduction (art. 55 bis)", () => {
  it("deducts the interest in full up to 8 UTA below 90 UTA of gross income", () => {
    expect(mortgageInterestDeduction(3_000_000, 50 * UTA, UTA)).toBe(3_000_000);
    expect(mortgageInterestDeduction(9_000_000, 50 * UTA, UTA)).toBe(8 * UTA);
  });

  it("reduces it proportionally between 90 and 150 UTA and drops it above", () => {
    // 100 UTA: (250 − 166,7)% = 83,3%.
    expect(mortgageInterestDeduction(3_000_000, 100 * UTA, UTA)).toBe(Math.round(3_000_000 * 0.833));
    expect(mortgageInterestDeduction(3_000_000, 151 * UTA, UTA)).toBe(0);
  });
});
