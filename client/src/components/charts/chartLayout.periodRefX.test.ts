import { describe, expect, it } from "vitest";
import { currentPeriodRefX } from "./chartLayout";

const TODAY = "2026-08-01";

describe("currentPeriodRefX", () => {
  it("month grain: picks the plotted date inside the current month", () => {
    const dates = ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
    expect(currentPeriodRefX(dates, "month", TODAY)).toBe("2026-08-31");
  });

  it("returns null when the current period is the last plotted date", () => {
    expect(currentPeriodRefX(["2026-06-30", "2026-07-31", "2026-08-31"], "month", TODAY)).toBeNull();
    expect(currentPeriodRefX(["2026-07-30", "2026-08-01"], "day", TODAY)).toBeNull();
    expect(currentPeriodRefX(["2025-12-31", "2026-12-31"], "year", TODAY)).toBeNull();
  });

  it("returns null when the current period has no plotted date", () => {
    expect(currentPeriodRefX(["2026-06-30", "2026-07-31"], "month", TODAY)).toBeNull();
    expect(currentPeriodRefX([], "month", TODAY)).toBeNull();
  });

  it("day grain: matches today exactly", () => {
    const dates = ["2026-07-30", "2026-07-31", "2026-08-01", "2026-09-10"];
    expect(currentPeriodRefX(dates, "day", TODAY)).toBe("2026-08-01");
  });

  it("year grain: matches the current year bucket on YYYY prefix (YYYY-12 keys included)", () => {
    expect(currentPeriodRefX(["2025-12-31", "2026-12-31", "2027-12-31"], "year", TODAY)).toBe(
      "2026-12-31"
    );
    expect(currentPeriodRefX(["2025-12", "2026-12", "2027-12"], "year", TODAY)).toBe("2026-12");
  });

  it("month grain: works on YYYY-MM keys (CC historial rows)", () => {
    expect(currentPeriodRefX(["2026-07", "2026-08", "2026-09"], "month", TODAY)).toBe("2026-08");
  });
});
