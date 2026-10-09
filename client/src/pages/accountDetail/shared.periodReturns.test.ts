import { describe, expect, it } from "vitest";
import { mayHavePeriodReturns } from "./shared";

describe("mayHavePeriodReturns", () => {
  it("frames the Rentabilidad table for the investment buckets and for an account with no card row yet", () => {
    expect(mayHavePeriodReturns({ dashboard_bucket_slug: "brokerage" })).toBe(true);
    expect(mayHavePeriodReturns({ dashboard_bucket_slug: "retirement" })).toBe(true);
    expect(mayHavePeriodReturns(null)).toBe(true);
    expect(mayHavePeriodReturns(undefined)).toBe(true);
  });

  it("does not frame it for the other buckets, nor for a liability (no bucket)", () => {
    expect(mayHavePeriodReturns({ dashboard_bucket_slug: "cash_eqs" })).toBe(false);
    expect(mayHavePeriodReturns({ dashboard_bucket_slug: "real_estate" })).toBe(false);
    expect(mayHavePeriodReturns({ dashboard_bucket_slug: null })).toBe(false);
    expect(mayHavePeriodReturns({})).toBe(false);
  });
});
