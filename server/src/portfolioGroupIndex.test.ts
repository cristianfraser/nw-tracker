import { describe, expect, it } from "vitest";
import { accountIdsInPortfolioGroup, withPortfolioGroupIndex } from "./portfolioGroupTree.js";

describe("withPortfolioGroupIndex", () => {
  it("returns the same account ids with or without the index wrapper", () => {
    const direct = accountIdsInPortfolioGroup("brokerage");
    const wrapped = withPortfolioGroupIndex(() => accountIdsInPortfolioGroup("brokerage"));
    expect(wrapped).toEqual(direct);
  });
});
