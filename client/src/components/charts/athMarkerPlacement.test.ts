import { describe, expect, it } from "vitest";
import { athTooltipIndexTolerance, isNearAthRow, resolveAthMarkerRow } from "./athMarkerPlacement";

const monthRows = [
  { as_of_date: "2026-01-31", total_nw: 10 },
  { as_of_date: "2026-02-28", total_nw: 12 },
  { as_of_date: "2026-03-31", total_nw: 11 },
];

describe("resolveAthMarkerRow", () => {
  it("day grid: exact day only", () => {
    const rows = [{ as_of_date: "2026-03-13" }, { as_of_date: "2026-03-14" }, { as_of_date: "2026-03-15" }];
    expect(resolveAthMarkerRow(rows, "2026-03-14", "day")).toEqual({ x: "2026-03-14", index: 1 });
    expect(resolveAthMarkerRow(rows, "2026-03-16", "day")).toBeNull();
  });

  it("month grid: the row of the peak's month, whatever day that row is dated", () => {
    expect(resolveAthMarkerRow(monthRows, "2026-02-14", "month")).toEqual({ x: "2026-02-28", index: 1 });
    // A mid-month snapshot row still owns its month.
    const snap = [{ as_of_date: "2026-05-31" }, { as_of_date: "2026-06-08" }];
    expect(resolveAthMarkerRow(snap, "2026-06-20", "month")).toEqual({ x: "2026-06-08", index: 1 });
  });

  it("year grid: the year-end row of the peak's year", () => {
    const years = [{ as_of_date: "2025-12-31" }, { as_of_date: "2026-12-31" }];
    expect(resolveAthMarkerRow(years, "2026-02-14", "year")).toEqual({ x: "2026-12-31", index: 1 });
  });

  it("is null when the range clip left the peak out of the window", () => {
    expect(resolveAthMarkerRow(monthRows, "2025-11-03", "month")).toBeNull();
    expect(resolveAthMarkerRow([], "2026-02-14", "month")).toBeNull();
  });
});

describe("tooltip nearness to the ATH row", () => {
  it("scales the tolerance with the plotted row count, never below the adjacent row", () => {
    expect(athTooltipIndexTolerance(12)).toBe(1); // yearly
    expect(athTooltipIndexTolerance(36)).toBe(1); // monthly, 3y
    expect(athTooltipIndexTolerance(1096)).toBe(13); // daily, 3y
  });

  it("is symmetric around the peak and exact at the peak", () => {
    expect(isNearAthRow(500, 500, 1096)).toBe(true);
    expect(isNearAthRow(487, 500, 1096)).toBe(true);
    expect(isNearAthRow(513, 500, 1096)).toBe(true);
    expect(isNearAthRow(486, 500, 1096)).toBe(false);
    expect(isNearAthRow(5, 3, 12)).toBe(false);
    expect(isNearAthRow(4, 3, 12)).toBe(true);
  });
});
