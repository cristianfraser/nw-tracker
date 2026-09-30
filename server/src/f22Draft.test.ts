import { describe, expect, it } from "vitest";
import { computeF22Tax, igcTax } from "./f22Draft.js";

const UTA = 800_000;

describe("igcTax", () => {
  it("applies the bracket's rate less its deduction, zero below 13,5 UTA", () => {
    expect(igcTax(10 * UTA, UTA, 2030)).toBe(0);
    // 52 UTA: 13,5% bracket, deduction 4,49 UTA.
    expect(igcTax(52 * UTA, UTA, 2030)).toBeCloseTo(52 * UTA * 0.135 - 4.49 * UTA, 6);
    expect(() => igcTax(52 * UTA, UTA, 2019)).toThrow(/no table/);
  });
});

describe("computeF22Tax", () => {
  it("runs the chain from income codes to 304", () => {
    const codes = computeF22Tax({ 1098: 40_000_000, 155: 5_000_000, 152: 100, 169: 1_000, 750: 3_000_000, 162: 1_500_000 }, UTA, 2030);
    expect(codes[158]).toBe(44_999_100);
    expect(codes[170]).toBe(41_999_100);
    const igc = Math.round(igcTax(41_999_100, UTA, 2030));
    expect(codes[157]).toBe(igc);
    expect(codes[136]).toBe(Math.round((igc * 100) / 44_999_100));
    expect(codes[304]).toBe(igc - codes[136]! - 1_500_000);
  });

  it("adds crypto gains, foreign income and its gross-up, and takes the foreign tax credit", () => {
    const base = { 1098: 40_000_000, 162: 1_500_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const withMore = computeF22Tax({ ...base, 1032: 1_000_000, 1104: 8_500, 748: 1_500, 1018: 1_500 }, UTA, 2030);
    expect(withMore[158]! - plain[158]!).toBe(1_010_000);
    expect(withMore[304]! - plain[304]!).toBe(Math.round(withMore[157]! - plain[157]!) - 1_500);
  });
});
