import { describe, expect, it } from "vitest";
import {
  emptyAccountMonthlyPerfRows,
  monthEndYmd,
  monthEndYmdsThroughToday,
} from "./placeholderMonthRows";

describe("monthEndYmd", () => {
  it("returns last day of month", () => {
    expect(monthEndYmd(2025, 2)).toBe("2025-02-28");
    expect(monthEndYmd(2024, 2)).toBe("2024-02-29");
  });
});

describe("monthEndYmdsThroughToday", () => {
  it("includes current month end", () => {
    const ends = monthEndYmdsThroughToday(2);
    const now = new Date();
    const y = now.getFullYear();
    const expectedEnd = monthEndYmd(y, now.getMonth() + 1);
    expect(ends[ends.length - 1]).toBe(expectedEnd);
    expect(ends.length).toBeGreaterThanOrEqual(2);
  });
});

describe("emptyAccountMonthlyPerfRows", () => {
  it("aligns row count with month-end series through today", () => {
    const rows = emptyAccountMonthlyPerfRows(42, "clp");
    expect(rows.length).toBe(monthEndYmdsThroughToday().length);
    expect(rows.every((r) => r.unit === "clp")).toBe(true);
    expect(rows.every((r) => r.nominal_pl == null)).toBe(true);
  });
});
