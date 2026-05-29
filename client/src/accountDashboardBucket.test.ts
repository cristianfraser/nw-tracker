import { describe, expect, it } from "vitest";
import { accountBelongsToDashboardBucket } from "./accountDashboardBucket";

describe("accountDashboardBucket", () => {
  it("uses dashboard_bucket_slug when present", () => {
    expect(
      accountBelongsToDashboardBucket(
        {
          group_slug: "brokerage_mutual_funds",
          bucket_slug: "brokerage_mutual_funds",
          dashboard_bucket_slug: "brokerage",
        },
        "brokerage"
      )
    ).toBe(true);
    expect(
      accountBelongsToDashboardBucket(
        {
          group_slug: "brokerage_crypto",
          bucket_slug: "brokerage_crypto",
          dashboard_bucket_slug: "brokerage",
        },
        "retirement"
      )
    ).toBe(false);
  });
});
