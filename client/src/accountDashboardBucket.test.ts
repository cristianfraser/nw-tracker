import { describe, expect, it } from "vitest";
import { accountBelongsToDashboardBucket } from "./accountDashboardBucket";

describe("accountBelongsToDashboardBucket", () => {
  it("matches when placement slug equals the dashboard bucket", () => {
    expect(
      accountBelongsToDashboardBucket(
        {
          group_slug: "brokerage_mutual_funds",
          bucket_slug: "brokerage_mutual_funds",
        },
        "brokerage"
      )
    ).toBe(false);
    expect(
      accountBelongsToDashboardBucket(
        {
          group_slug: "brokerage",
          bucket_slug: "brokerage",
        },
        "brokerage"
      )
    ).toBe(true);
  });
});
