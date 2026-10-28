import { describe, expect, it } from "vitest";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals";
import cases from "../../server/src/test/accountCountsTowardGroupTotalsCases.json";

describe("accountCountsTowardGroupTotals", () => {
  // The server's case table (its own suite asserts the same rows against the server rule).
  it.each(cases)("exclude_from_group_totals=$exclude_from_group_totals → $counts", (c) => {
    const row =
      c.exclude_from_group_totals === "absent"
        ? {}
        : { exclude_from_group_totals: c.exclude_from_group_totals as number | null };
    expect(accountCountsTowardGroupTotals(row)).toBe(c.counts);
  });
});
