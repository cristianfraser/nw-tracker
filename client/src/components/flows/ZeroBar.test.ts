import { describe, expect, it } from "vitest";
import { zeroBarExtent, zeroBarSides } from "./ZeroBar";

describe("zeroBarSides", () => {
  it("puts losses left and gains right in the order given, and leaves zeros out", () => {
    const sides = zeroBarSides([
      { key: "brokerage", color: "a", value: 40 },
      { key: "retirement", color: "b", value: -25 },
      { key: "cash", color: "c", value: 0 },
      { key: "real_estate", color: "d", value: -5 },
    ]);
    expect(sides.right).toEqual([{ key: "brokerage", color: "a", amount: 40 }]);
    expect(sides.left).toEqual([
      { key: "retirement", color: "b", amount: 25 },
      { key: "real_estate", color: "d", amount: 5 },
    ]);
  });

  it("reaches as far as its longer side or its mark, whatever the mark's sign", () => {
    const sides = zeroBarSides([
      { key: "x", color: "a", value: 40 },
      { key: "y", color: "b", value: -30 },
    ]);
    expect(zeroBarExtent(sides)).toBe(40);
    expect(zeroBarExtent(sides, -55)).toBe(55);
    expect(zeroBarExtent(zeroBarSides([]))).toBe(0);
  });
});
