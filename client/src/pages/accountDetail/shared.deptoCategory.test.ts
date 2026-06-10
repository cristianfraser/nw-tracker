import { describe, expect, it } from "vitest";
import { isDeptoMortgageCategory, isDeptoPropertyCategory } from "./shared";

describe("depto account category helpers", () => {
  it("treats real_estate as property depto", () => {
    expect(isDeptoPropertyCategory("real_estate")).toBe(true);
    expect(isDeptoPropertyCategory("property")).toBe(true);
    expect(isDeptoMortgageCategory("real_estate")).toBe(false);
  });

  it("treats mortgage as mortgage depto", () => {
    expect(isDeptoMortgageCategory("mortgage")).toBe(true);
    expect(isDeptoPropertyCategory("mortgage")).toBe(false);
  });
});
