import { describe, expect, it } from "vitest";
import {
  buildProportionalFromPoints,
  buildProportionalFromValueArrays,
} from "./proportionalSeries.js";

describe("buildProportionalFromPoints", () => {
  it("shares sum to 1 per date; negatives floor to 0; empty base emits nulls", () => {
    const points = [
      { as_of_date: "2026-01-31", a: 75, b: 25 },
      // Negative member floors to 0 — the composition is share-of-assets.
      { as_of_date: "2026-02-28", a: 100, b: -40 },
      // Null member contributes 0 but the date still normalizes over the rest.
      { as_of_date: "2026-03-31", a: 60, b: null },
      // No base at all → nulls (the chart skips the date).
      { as_of_date: "2026-04-30", a: 0, b: null },
    ];
    const block = buildProportionalFromPoints(points, [
      { dataKey: "a", name: "A", account_id: 1 },
      { dataKey: "b", name: "B", account_id: 2 },
    ]);

    expect(block.dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    const a = block.series.find((s) => s.dataKey === "a")!;
    const b = block.series.find((s) => s.dataKey === "b")!;
    expect(a.account_id).toBe(1);
    expect(a.values).toEqual([0.75, 1, 1, null]);
    expect(b.values).toEqual([0.25, 0, 0, null]);
    for (let i = 0; i < block.dates.length; i++) {
      const sum = (a.values[i] ?? 0) + (b.values[i] ?? 0);
      if (a.values[i] != null) expect(sum).toBeCloseTo(1, 9);
    }
  });
});

describe("buildProportionalFromValueArrays", () => {
  it("normalizes parallel arrays on the shared grid", () => {
    const block = buildProportionalFromValueArrays(
      ["2026-07-01", "2026-07-02"],
      [
        { dataKey: "10", name: "X", account_id: 10, values: [30, 0] },
        { dataKey: "11", name: "Y", account_id: 11, values: [70, 50] },
      ]
    );
    expect(block.series[0]!.values).toEqual([0.3, 0]);
    expect(block.series[1]!.values).toEqual([0.7, 1]);
  });
});
