import { describe, expect, it } from "vitest";
import { pageForFirstMatch } from "./PaginatedTable";

describe("pageForFirstMatch", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ i }));

  it("returns 1 for empty rows", () => {
    expect(pageForFirstMatch([], 12, () => true)).toBe(1);
  });

  it("finds a match on the first page", () => {
    expect(pageForFirstMatch(rows, 12, (r) => r.i === 0)).toBe(1);
    expect(pageForFirstMatch(rows, 12, (r) => r.i === 11)).toBe(1);
  });

  it("crosses the page boundary at pageSize", () => {
    expect(pageForFirstMatch(rows, 12, (r) => r.i === 12)).toBe(2);
    expect(pageForFirstMatch(rows, 12, (r) => r.i === 23)).toBe(2);
    expect(pageForFirstMatch(rows, 12, (r) => r.i === 24)).toBe(3);
  });

  it("returns the last page when nothing matches (all rows are future)", () => {
    expect(pageForFirstMatch(rows, 12, () => false)).toBe(3);
    expect(pageForFirstMatch(rows.slice(0, 12), 12, () => false)).toBe(1);
    expect(pageForFirstMatch(rows.slice(0, 13), 12, () => false)).toBe(2);
  });

  it("uses the first match on a descending list (current or nearest-past month)", () => {
    // Newest-first months; today = 2026-07. First row <= today is the current-or-past month.
    const months = [
      "2027-11", "2027-10", "2027-09", "2027-08", "2027-07", "2027-06",
      "2027-05", "2027-04", "2027-03", "2027-02", "2027-01", "2026-12",
      "2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06",
    ].map((period_month) => ({ period_month }));
    expect(pageForFirstMatch(months, 12, (r) => r.period_month <= "2026-07")).toBe(2);
  });
});
