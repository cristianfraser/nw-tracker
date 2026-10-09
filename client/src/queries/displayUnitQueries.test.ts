import { describe, expect, it } from "vitest";
import { keepPreviousDataSameEntity } from "./displayUnitQueries";

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
    const group = keepPreviousDataSameEntity(["portfolioGroup", "brokerage", null, "clp"], 2);
    expect(group({ v: 1 }, prevQuery(["portfolioGroup", "retirement", null, "clp"]))).toBeUndefined();
  });

  it("offers nothing without a previous query or payload", () => {
    const hold = keepPreviousDataSameEntity(["dashboard", "clp"], 1);
    expect(hold({ v: 1 }, undefined)).toBeUndefined();
    expect(hold(undefined, prevQuery(["dashboard", "usd"]))).toBeUndefined();
  });
});
