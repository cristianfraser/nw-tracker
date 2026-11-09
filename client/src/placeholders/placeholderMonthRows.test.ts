import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 10, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs from N months back through the current month's end, across a year boundary", () => {
    expect(monthEndYmdsThroughToday(2)).toEqual(["2025-12-31", "2026-01-31", "2026-02-28"]);
  });
});

describe("emptyAccountMonthlyPerfRows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 10, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aligns row count with month-end series through today", () => {
    const rows = emptyAccountMonthlyPerfRows(42, "clp");
    expect(rows.length).toBe(25);
    expect(rows.every((r) => r.unit === "clp")).toBe(true);
    expect(rows.every((r) => r.nominal_pl == null)).toBe(true);
  });
});
