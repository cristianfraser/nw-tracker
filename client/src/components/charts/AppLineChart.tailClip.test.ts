import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAILING_ZERO_MONTHS_KEPT,
  applyMultiSeriesTrailingZeroTailClip,
  trailingZeroTailClipStartIndex,
} from "./AppLineChart";

describe("DEFAULT_TRAILING_ZERO_MONTHS_KEPT", () => {
  it("keeps one trailing zero month (display only)", () => {
    expect(DEFAULT_TRAILING_ZERO_MONTHS_KEPT).toBe(1);
  });
});

describe("trailingZeroTailClipStartIndex", () => {
  const points = [
    { as_of_date: "2026-04-30", s: 0 },
    { as_of_date: "2026-05-31", s: 100 },
    { as_of_date: "2026-06-30", s: 0 },
    { as_of_date: "2026-07-31", s: 0 },
    { as_of_date: "2026-08-31", s: 0 },
  ];

  it("keeps a single trailing zero", () => {
    expect(trailingZeroTailClipStartIndex([{ s: 100 }, { s: 0 }], "s", 1)).toBeNull();
  });

  it("nulls from the second trailing zero onward", () => {
    expect(trailingZeroTailClipStartIndex(points, "s", 1)).toBe(3);
  });
});

describe("applyMultiSeriesTrailingZeroTailClip", () => {
  it("collapses 2+ trailing zeros to one plotted zero", () => {
    const points = [
      { as_of_date: "2026-05-31", s: 100 },
      { as_of_date: "2026-06-30", s: 0 },
      { as_of_date: "2026-07-31", s: 0 },
    ];
    const { points: out } = applyMultiSeriesTrailingZeroTailClip(points, {
      series: [{ dataKey: "s", type: "data" }],
    });
    expect(out.map((r) => r.s)).toEqual([100, 0, null]);
  });
});
