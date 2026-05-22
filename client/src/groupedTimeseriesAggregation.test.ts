import { describe, expect, it } from "vitest";
import { aggregatePieByBucket } from "./groupedTimeseriesAggregation";

describe("aggregatePieByBucket", () => {
  it("sums slice values that map to the same bucket", () => {
    const meta = {
      a: { key: "a", accountId: -1, dataKey: "d_a", depKey: "dep_a", barDataKey: "pl_a", name: "A" },
      b: { key: "b", accountId: -2, dataKey: "d_b", depKey: "dep_b", barDataKey: "pl_b", name: "B" },
    };
    const out = aggregatePieByBucket(
      [
        { name: "x", account_id: 10, value: 100 },
        { name: "y", account_id: 11, value: 50 },
        { name: "z", account_id: 20, value: 200 },
      ],
      ["a", "b"],
      meta,
      (id) => (id === 10 || id === 11 ? "a" : id === 20 ? "b" : null)
    );
    expect(out).toEqual([
      { name: "A", account_id: -1, value: 150 },
      { name: "B", account_id: -2, value: 200 },
    ]);
  });
});
