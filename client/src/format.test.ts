import { describe, expect, it } from "vitest";
import { formatClp, formatCcExpenseLineAmount } from "./format";

describe("formatClp", () => {
  it("formats negatives with accounting parentheses", () => {
    expect(formatClp(-1234)).toBe("($1.234)");
  });

  it("returns em dash for non-finite values", () => {
    expect(formatClp(Number.NaN)).toBe("—");
  });
});

describe("formatCcExpenseLineAmount", () => {
  it("shows CLP with optional USD parenthetical", () => {
    expect(formatCcExpenseLineAmount(50_000, 60)).toContain("50");
    expect(formatCcExpenseLineAmount(50_000, 60)).toContain("60");
  });
});
