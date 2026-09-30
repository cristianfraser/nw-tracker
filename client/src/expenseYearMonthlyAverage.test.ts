import { describe, expect, it } from "vitest";
import { expenseYearMonthlyAverages } from "./expenseYearMonthlyAverage";
import type { FlowCcExpenseCategoryChartPoint } from "./types";

const SLUGS = ["food", "bills"];

function pt(ym: string, food: number, bills = 0): FlowCcExpenseCategoryChartPoint {
  return { as_of_date: `${ym}-28`, food, bills };
}

describe("expenseYearMonthlyAverages", () => {
  it("averages the category total over the year's complete months, current year through last month", () => {
    const points = [
      pt("2025-01", 100, 20),
      pt("2025-12", 300),
      pt("2026-01", 100),
      pt("2026-08", 700),
      pt("2026-09", 9_999), // current month: left out
      pt("2026-11", 5_000), // projected cuota month: left out
    ];
    const avgs = expenseYearMonthlyAverages(points, SLUGS, "2026-09");
    // 2025: 420 over 12 months (the months with no points count as 0).
    expect(avgs.get("2025")).toEqual({ fromYm: "2025-01", throughYm: "2025-12", avg: 35 });
    // 2026: 800 over Jan–Aug.
    expect(avgs.get("2026")).toEqual({ fromYm: "2026-01", throughYm: "2026-08", avg: 100 });
    expect(avgs.has("2027")).toBe(false);
  });

  it("starts the first year at its first month with spend", () => {
    const avgs = expenseYearMonthlyAverages([pt("2024-10", 0), pt("2024-11", 300), pt("2024-12", 100)], SLUGS, "2025-03");
    expect(avgs.get("2024")).toEqual({ fromYm: "2024-11", throughYm: "2024-12", avg: 200 });
  });

  it("has no current-year entry in January (no complete month yet)", () => {
    const avgs = expenseYearMonthlyAverages([pt("2025-06", 100), pt("2026-01", 500)], SLUGS, "2026-01");
    expect([...avgs.keys()]).toEqual(["2025"]);
  });
});
