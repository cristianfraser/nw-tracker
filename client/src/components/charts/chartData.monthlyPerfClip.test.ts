import { describe, expect, it } from "vitest";
import {
  filterPointsThroughAsOfDate,
  resolveMonthlyPerfClipEndDate,
} from "./chartData";

describe("resolveMonthlyPerfClipEndDate", () => {
  it("extends clip end when newest perf row is after chart tail-clip", () => {
    const rows = [
      { as_of_date: "2026-06-03" },
      { as_of_date: "2026-06-02" },
    ];
    const clipEnd = resolveMonthlyPerfClipEndDate("2026-06-02", rows);
    expect(clipEnd).toBe("2026-06-03");
    expect(filterPointsThroughAsOfDate(rows, clipEnd)).toEqual(rows);
  });

  it("keeps chart tail-clip when perf rows are not newer", () => {
    const rows = [{ as_of_date: "2026-06-02" }];
    expect(resolveMonthlyPerfClipEndDate("2026-06-02", rows)).toBe("2026-06-02");
    expect(resolveMonthlyPerfClipEndDate("2026-06-02", [])).toBe("2026-06-02");
  });
});
