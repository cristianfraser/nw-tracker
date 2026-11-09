import { describe, expect, it } from "vitest";
import { chartInactiveFromMonthlyClosingAsc } from "./accountValuationTailInactive.js";

describe("chartInactiveFromMonthlyClosingAsc", () => {
  it("stays active when the latest month-end is non-zero", () => {
    expect(chartInactiveFromMonthlyClosingAsc([100, 0, 50], 0)).toBe(false);
    expect(chartInactiveFromMonthlyClosingAsc([100, 50, 25], 0)).toBe(false);
  });

  it("is inactive after one trailing zero month-end", () => {
    expect(chartInactiveFromMonthlyClosingAsc([100, 0], 0)).toBe(true);
  });

  it("is inactive when the full history is zero", () => {
    expect(chartInactiveFromMonthlyClosingAsc([0, 0, 0], 0)).toBe(true);
  });

  it("reactivates when a trailing zero is followed by a non-zero month-end", () => {
    expect(chartInactiveFromMonthlyClosingAsc([100, 0, 25], 0)).toBe(false);
  });
});
