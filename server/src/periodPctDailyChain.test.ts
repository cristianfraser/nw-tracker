import { describe, expect, it } from "vitest";
import { chainDailyPct, chainPeriodStartYmd, withDailyChainedMonthPct } from "./periodPctDailyChain.js";
import { withChainedGroupPct, type ChainedGroupPct } from "./dashboardNavCardMetrics.js";

describe("chainPeriodStartYmd", () => {
  it("starts each period after its prior close: yesterday, last month-end, last year-end, none", () => {
    expect(chainPeriodStartYmd("day", "2026-10-27")).toBe("2026-10-26");
    expect(chainPeriodStartYmd("month", "2026-10-27")).toBe("2026-09-30");
    expect(chainPeriodStartYmd("year", "2026-10-27")).toBe("2025-12-31");
    expect(chainPeriodStartYmd("total", "2026-10-27")).toBeNull();
  });
});

describe("chainDailyPct", () => {
  // Bought on 05-28, sold on 06-16: the days with nothing held carry no return.
  const points = [
    { as_of_date: "2025-12-31", pct: 0.5 },
    { as_of_date: "2026-05-27", pct: null },
    { as_of_date: "2026-05-29", pct: 0.1 },
    { as_of_date: "2026-06-10", pct: -0.2 },
    { as_of_date: "2026-06-16", pct: 0.05 },
    { as_of_date: "2026-06-17", pct: null },
  ];

  it("chains the days inside the window, skipping days without a return", () => {
    expect(chainDailyPct(points, "2025-12-31", "2026-10-27")).toBeCloseTo(1.1 * 0.8 * 1.05 - 1, 12);
    expect(chainDailyPct(points, null, "2026-10-27")).toBeCloseTo(1.5 * 1.1 * 0.8 * 1.05 - 1, 12);
  });

  it("is null when no day in the window has a return", () => {
    expect(chainDailyPct(points, "2026-06-16", "2026-10-27")).toBeNull();
  });
});

describe("withDailyChainedMonthPct", () => {
  const points = [
    { as_of_date: "2026-08-31", pct: 0.5 },
    { as_of_date: "2026-09-01", pct: 0.1 },
    { as_of_date: "2026-09-15", pct: null },
    { as_of_date: "2026-09-30", pct: -0.1 },
    { as_of_date: "2026-10-01", pct: 0.02 },
    { as_of_date: "2026-10-05", pct: 0.03 },
  ];

  it("compounds each row's calendar month through the row's date", () => {
    const rows = [
      { as_of_date: "2026-10-03", pct_month: 9, nominal_pl: 1 },
      { as_of_date: "2026-09-30", pct_month: 9, nominal_pl: 2 },
      { as_of_date: "2026-07-31", pct_month: 9, nominal_pl: 3 },
    ];
    const out = withDailyChainedMonthPct(rows, points);
    expect(out[0]!.pct_month).toBeCloseTo(0.02, 12);
    expect(out[1]!.pct_month).toBeCloseTo(1.1 * 0.9 - 1, 12);
    expect(out[2]!.pct_month).toBeNull();
    expect(out[1]!.nominal_pl).toBe(2);
  });
});

describe("withChainedGroupPct", () => {
  const pct = {
    day: { value: 0.02 },
    month: { value: 0.04 },
    year: { value: 0.06 },
    total: { value: 0.6 },
  };

  it("reads every cell from the resolver in the unit and keeps the one-step Total as on_deposits", () => {
    const asked: string[] = [];
    const chained: ChainedGroupPct = (_scope, p, unit) => {
      asked.push(unit);
      return p === "year" ? null : -0.04;
    };
    const out = withChainedGroupPct(pct, { kind: "group", slug: "x" }, "usd", chained);
    expect(new Set(asked)).toEqual(new Set(["usd"]));
    expect(out.day).toEqual({ value: -0.04 });
    expect(out.year).toEqual({ value: null });
    expect(out.total).toEqual({ value: -0.04, on_deposits: 0.6 });
  });

  it("keeps the one-step cells of a liabilities-only scope", () => {
    const out = withChainedGroupPct(pct, { kind: "group", slug: "x" }, "clp", () => undefined);
    expect(out).toEqual(pct);
  });

  it("is the identity without a resolver", () => {
    expect(withChainedGroupPct(pct, { kind: "group", slug: "x" }, "clp", undefined)).toBe(pct);
  });
});
