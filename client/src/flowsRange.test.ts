import { describe, expect, it } from "vitest";
import { sumChartPointsField } from "./flowsDisplay";
import { clipPointsToTimeRange, timeRangeCutoffYmd } from "./timeRange";

type Pt = { as_of_date: string; total: number };

const MONTHLY: Pt[] = [
  { as_of_date: "2024-01-31", total: 10 },
  { as_of_date: "2024-06-30", total: 20 },
  { as_of_date: "2025-01-31", total: 30 },
  { as_of_date: "2025-07-31", total: 40 },
];

describe("flows Rango helpers", () => {
  it("clipPointsToTimeRange at 'total' returns identical content (Rango=Todo ≡ today)", () => {
    const clipped = clipPointsToTimeRange(MONTHLY, "total");
    expect(clipped).toEqual(MONTHLY);
    // and the range-scoped sum over all points equals the full-history figure
    expect(sumChartPointsField(clipped, "total")).toBe(sumChartPointsField(MONTHLY, "total"));
  });

  it("clipPointsToTimeRange filters to the range cutoff", () => {
    const today = "2025-07-31";
    const cutoff = timeRangeCutoffYmd("1y", today); // ~2024-07-31
    expect(cutoff).not.toBeNull();
    const clipped = clipPointsToTimeRange(MONTHLY, "1y", today);
    // 2024-01 and 2024-06 fall before the 1y cutoff; 2025-01 and 2025-07 remain
    expect(clipped.map((p) => p.as_of_date)).toEqual(["2025-01-31", "2025-07-31"]);
    expect(sumChartPointsField(clipped, "total")).toBe(70);
  });

  it("sumChartPointsField ignores non-numeric / missing fields", () => {
    const mixed = [
      { as_of_date: "2025-01-31", total: 5 },
      { as_of_date: "2025-02-28", total: Number.NaN },
      { as_of_date: "2025-03-31" } as Pt,
    ];
    expect(sumChartPointsField(mixed, "total")).toBe(5);
  });
});
