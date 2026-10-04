import { describe, expect, it } from "vitest";
import type { PeriodReturnCell, PeriodReturnsPayload } from "./periodReturns.js";
import { withDailyChainedReturns } from "./periodReturnsDaily.js";

function cell(period: PeriodReturnCell["period"], start: { month?: string; date?: string }): PeriodReturnCell {
  return {
    period,
    pct: 0.5,
    nominal_pl: 123,
    annualized_pct: null,
    months: 1,
    window_start_month: start.month ?? null,
    ...(start.date ? { window_start_date: start.date } : {}),
  };
}

describe("withDailyChainedReturns", () => {
  const payload: PeriodReturnsPayload = {
    unit: "clp",
    as_of_date: "2026-03-10",
    first_month: "2024-01",
    periods: [
      cell("d1", { date: "2026-03-09" }),
      cell("mtd", { month: "2026-03" }),
      cell("total", { month: "2024-01" }),
    ],
  };
  const points = [
    { as_of_date: "2023-12-31", pct: 9 }, // before every window: ignored
    { as_of_date: "2024-01-15", pct: 0.1 },
    { as_of_date: "2026-02-28", pct: null }, // nothing held: flat
    { as_of_date: "2026-03-02", pct: 0.2 },
    { as_of_date: "2026-03-11", pct: 5 }, // after today: ignored
  ];

  it("chains the daily returns over each month window, keeping pesos and 1D/1W", () => {
    const out = withDailyChainedReturns(payload, points, "2026-03-10")!;
    const [d1, mtd, total] = out.periods;
    expect(d1).toEqual(payload.periods[0]);
    expect(mtd!.pct).toBeCloseTo(0.2);
    expect(mtd!.nominal_pl).toBe(123);
    expect(total!.pct).toBeCloseTo(1.1 * 1.2 - 1);
    // 27 calendar months (2024-01 … 2026-03): annualized.
    expect(total!.annualized_pct).toBeCloseTo(Math.pow(1.32, 12 / 27) - 1);
    expect(mtd!.annualized_pct).toBeNull();
  });

  it("a window with no daily return at all is null", () => {
    const out = withDailyChainedReturns(payload, [{ as_of_date: "2026-03-05", pct: null }], "2026-03-10")!;
    expect(out.periods[1]!.pct).toBeNull();
  });
});

describe("unvaluedMemberDays", () => {
  it("flags a run without a mark that money entered and that ends in a mark", async () => {
    const { unvaluedMemberDays } = await import("./dailySeries.js");
    // grid days 0..6; flows[g − 1] is day g's flow. Money arrives on day 2, the mark on day 4.
    const marks = [null, null, null, null, 100, 101, 102];
    const flows = [0, 50, 0, 0, 0, 0];
    expect(unvaluedMemberDays(marks, flows)).toEqual([true, true, true, true, true, false, false]);
  });

  it("leaves alone an account opened with a mark the day money arrives, and one never valued again", async () => {
    const { unvaluedMemberDays } = await import("./dailySeries.js");
    expect(unvaluedMemberDays([null, null, 100, 90], [0, 100, 0])).toEqual([false, false, false, false]);
    expect(unvaluedMemberDays([100, 0, null, null], [0, -100, 5])).toEqual([false, false, false, false]);
  });
});
