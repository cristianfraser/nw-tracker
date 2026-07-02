import { describe, expect, it } from "vitest";
import {
  TS_TRAILING_ZERO_MONTHS_KEPT,
  applyTrailingZeroTailClipToBlock,
  trailingZeroTailClipStartIndex,
} from "./timeseriesTailClip.js";

describe("TS_TRAILING_ZERO_MONTHS_KEPT", () => {
  it("keeps one trailing zero month (display only)", () => {
    expect(TS_TRAILING_ZERO_MONTHS_KEPT).toBe(1);
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

function accountLine(dataKey: string, extra: Record<string, unknown> = {}) {
  return {
    account_id: Number(dataKey) || 1,
    name: dataKey,
    dataKey,
    valueSeriesType: "data" as const,
    ...extra,
  };
}

describe("applyTrailingZeroTailClipToBlock", () => {
  it("collapses 2+ trailing zeros to one plotted zero", () => {
    const block = {
      accounts: [accountLine("7")],
      points: [
        { as_of_date: "2026-05-31", "7": 100 },
        { as_of_date: "2026-06-30", "7": 0 },
        { as_of_date: "2026-07-31", "7": 0 },
        { as_of_date: "2026-08-31", "7": 0 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    expect(out.points.map((r) => r["7"])).toEqual([100, 0]);
    expect(out.tail_clipped_keys).toEqual(["7"]);
    expect(out.chart_end_ymd).toBe("2026-06-30");
  });

  it("does not trim the x-range when another data series continues", () => {
    const block = {
      accounts: [accountLine("7"), accountLine("8")],
      points: [
        { as_of_date: "2026-05-31", "7": 100, "8": 5 },
        { as_of_date: "2026-06-30", "7": 0, "8": 6 },
        { as_of_date: "2026-07-31", "7": 0, "8": 7 },
        { as_of_date: "2026-08-31", "7": 0, "8": 8 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    expect(out.points).toHaveLength(4);
    expect(out.chart_end_ymd).toBeUndefined();
    expect(out.points.map((r) => r["7"])).toEqual([100, 0, null, null]);
    expect(out.points.map((r) => r["8"])).toEqual([5, 6, 7, 8]);
    expect(out.tail_clipped_keys).toEqual(["7"]);
  });

  it("bundles an account's deposit line with its valuation clip", () => {
    const block = {
      accounts: [accountLine("7", { depositDataKey: "7__dep" })],
      points: [
        { as_of_date: "2026-05-31", "7": 100, "7__dep": 90 },
        { as_of_date: "2026-06-30", "7": 0, "7__dep": 90 },
        { as_of_date: "2026-07-31", "7": 0, "7__dep": 90 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    expect(out.points.map((r) => r["7__dep"])).toEqual([90, 90]);
    expect(out.tail_clipped_keys).toEqual(["7", "7__dep"]);
  });

  it("returns the block unchanged when nothing qualifies", () => {
    const block = {
      accounts: [accountLine("7")],
      points: [
        { as_of_date: "2026-05-31", "7": 100 },
        { as_of_date: "2026-06-30", "7": 0 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    expect(out).toBe(block);
    expect(out.tail_clipped_keys).toBeUndefined();
  });

  it("never clips reference lines", () => {
    const block = {
      lines: [
        { dataKey: "total_nw", valueSeriesType: "data" as const },
        { dataKey: "ref_milestone", valueSeriesType: "reference" as const },
      ],
      points: [
        { as_of_date: "2026-05-31", total_nw: 100, ref_milestone: 0 },
        { as_of_date: "2026-06-30", total_nw: 0, ref_milestone: 0 },
        { as_of_date: "2026-07-31", total_nw: 0, ref_milestone: 0 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    expect(out.points.map((r) => r.ref_milestone)).toEqual([0, 0]);
    expect(out.tail_clipped_keys).toEqual(["total_nw"]);
    expect(out.chart_end_ymd).toBe("2026-06-30");
  });

  it("keeps the server consolidated __group_val_total for account-id lines", () => {
    const block = {
      accounts: [
        accountLine("78"),
        accountLine("46"),
        { account_id: -1, name: "Total", dataKey: "__group_val_total", valueSeriesType: "data" as const },
      ],
      points: [
        { as_of_date: "2026-05-31", "78": 29_408_136, "46": 63_875_141, __group_val_total: 95_680_506 },
        { as_of_date: "2026-06-30", "78": 0, "46": 63_875_141, __group_val_total: 63_875_141 },
        { as_of_date: "2026-07-31", "78": 0, "46": 63_875_141, __group_val_total: 63_875_141 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    // Guard: numeric account-id keys keep the consolidated cierre untouched.
    expect(out.points.map((r) => r.__group_val_total)).toEqual([95_680_506, 63_875_141, 63_875_141]);
    expect(out.points.map((r) => r["78"])).toEqual([29_408_136, 0, null]);
  });

  it("collapses an all-zero block to its kept zero month (client skeletons never pass through here)", () => {
    const block = {
      accounts: [accountLine("7")],
      points: [
        { as_of_date: "2026-05-31", "7": 0 },
        { as_of_date: "2026-06-30", "7": 0 },
        { as_of_date: "2026-07-31", "7": 0 },
      ],
    };
    const out = applyTrailingZeroTailClipToBlock(block);
    expect(out.points.map((r) => r["7"])).toEqual([0]);
    expect(out.chart_end_ymd).toBe("2026-05-31");
  });
});
