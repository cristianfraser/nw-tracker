import { describe, expect, it } from "vitest";
import { periodFromBukMonth } from "./payslipTable.js";

describe("periodFromBukMonth", () => {
  it("reads Buk's MM-YYYY month cell", () => {
    expect(periodFromBukMonth("09-2026")).toBe("2026-09");
    expect(periodFromBukMonth(" 12-2030 ")).toBe("2030-12");
  });
  it("refuses anything else", () => {
    expect(() => periodFromBukMonth("Septiembre 2026")).toThrow(/MM-YYYY/);
    expect(() => periodFromBukMonth("13-2026")).toThrow(/MM-YYYY/);
  });
});
