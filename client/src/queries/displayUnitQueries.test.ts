import { describe, expect, it } from "vitest";
import { keepPreviousDataSameEntity } from "./displayUnitQueries";
import { entityKeyLength, queryKeys } from "./keys";

const prevQuery = (queryKey: readonly unknown[]) => ({ queryKey });

describe("keepPreviousDataSameEntity", () => {
  it("holds the previous payload across a unit / window change of the same entity", () => {
    const hold = keepPreviousDataSameEntity(["accountDetail", "42", "usd", "monthly"], 2);
    expect(hold({ v: 1 }, prevQuery(["accountDetail", "42", "clp", "monthly"]))).toEqual({ v: 1 });
    const daily = keepPreviousDataSameEntity(["dailySeries", "pg:brokerage", "clp", 0], 2);
    expect(daily({ v: 2 }, prevQuery(["dailySeries", "pg:brokerage", "clp", 90]))).toEqual({ v: 2 });
  });

  it("drops the previous payload when the entity part of the key differs", () => {
    const hold = keepPreviousDataSameEntity(["accountDetail", "43", "clp", "monthly"], 2);
    expect(hold({ v: 1 }, prevQuery(["accountDetail", "42", "clp", "monthly"]))).toBeUndefined();
    const group = keepPreviousDataSameEntity(["portfolioGroup", "brokerage", "clp"], 2);
    expect(group({ v: 1 }, prevQuery(["portfolioGroup", "retirement", "clp"]))).toBeUndefined();
  });

  it("offers nothing without a previous query or payload", () => {
    const hold = keepPreviousDataSameEntity(["dashboard", "clp"], 1);
    expect(hold({ v: 1 }, undefined)).toBeUndefined();
    expect(hold(undefined, prevQuery(["dashboard", "usd"]))).toBeUndefined();
  });

  it("holds a page's nav context and a comparison across units, never across pages or benchmarks", () => {
    const sameEntity = (key: readonly unknown[], prev: readonly unknown[]) =>
      keepPreviousDataSameEntity(key, entityKeyLength(key))({ v: 1 }, prevQuery(prev)) !== undefined;
    expect(sameEntity(queryKeys.dashboardNav("brokerage", "usd"), queryKeys.dashboardNav("brokerage", "clp"))).toBe(true);
    expect(sameEntity(queryKeys.dashboardNav("brokerage", "usd"), queryKeys.dashboardNav("retirement", "usd"))).toBe(false);
    const cmp = queryKeys.benchmarkComparison("g:brokerage", "mortgage", "usd");
    expect(sameEntity(cmp, queryKeys.benchmarkComparison("g:brokerage", "mortgage", "clp"))).toBe(true);
    expect(sameEntity(cmp, queryKeys.benchmarkComparison("g:brokerage", "ipsa", "clp"))).toBe(false);
    const prepay = queryKeys.mortgageGroupPrepayments("liabilities_mortgage", "ipsa", "usd");
    expect(sameEntity(prepay, queryKeys.mortgageGroupPrepayments("liabilities_mortgage", "ipsa", "eur"))).toBe(true);
    expect(sameEntity(prepay, queryKeys.mortgageGroupPrepayments("liabilities_mortgage", "spx", "usd"))).toBe(false);
  });
});
