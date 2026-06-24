import { describe, expect, it } from "vitest";
import {
  CHART_TRAILING_ZERO_MONTHS_KEPT,
  chartInactiveFromMonthlyClosingAsc,
} from "./accountValuationTailInactive.js";

describe("chartInactiveFromMonthlyClosingAsc", () => {
  it("uses zero months kept by default", () => {
    expect(CHART_TRAILING_ZERO_MONTHS_KEPT).toBe(0);
  });

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
