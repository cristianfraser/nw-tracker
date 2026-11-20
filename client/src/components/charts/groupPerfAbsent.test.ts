import { describe, expect, it } from "vitest";
import { groupPerfAbsent } from "./groupPerfAbsent";

describe("groupPerfAbsent", () => {
  const base = { loading: false, barSeriesCount: 2, granularity: "month" as const, pointsCount: 5 };

  it("never reads a loading bundle as «no P/L»", () => {
    expect(groupPerfAbsent({ ...base, loading: true, barSeriesCount: 0, pointsCount: 0 })).toBe(false);
  });

  it("is absent when the loaded group has no bar series", () => {
    expect(groupPerfAbsent({ ...base, barSeriesCount: 0 })).toBe(true);
  });

  it("is absent when a monthly or yearly view has no points", () => {
    expect(groupPerfAbsent({ ...base, pointsCount: 0 })).toBe(true);
    expect(groupPerfAbsent({ ...base, granularity: "year", pointsCount: 0 })).toBe(true);
  });

  it("keeps a Diario combo with no points mounted (its daily series still loading)", () => {
    expect(groupPerfAbsent({ ...base, granularity: "day", pointsCount: 0 })).toBe(false);
  });

  it("is present with series and points", () => {
    expect(groupPerfAbsent(base)).toBe(false);
  });
});
