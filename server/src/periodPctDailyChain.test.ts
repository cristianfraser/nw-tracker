import { describe, expect, it } from "vitest";
import {
  chainDailyPct,
  chainPeriodStartYmd,
  withDailyChainedMonthPct,
  withDailyYtdPct,
} from "./periodPctDailyChain.js";
import { rollupMonthlyPerfYearly } from "./monthlyPerfRollup.js";
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

describe("YTD % on the detalle rows", () => {
  // Two years of daily returns: 2025's last day must not leak into 2026's YTD.
  const points = [
    { as_of_date: "2025-12-31", pct: 0.5 },
    { as_of_date: "2026-01-02", pct: 0.1 },
    { as_of_date: "2026-02-10", pct: null },
    { as_of_date: "2026-02-27", pct: -0.05 },
    { as_of_date: "2026-03-03", pct: 0.02 },
  ];
  // The Rentabilidad YTD window at a date: from the prior year-end (exclusive) through the date.
  const ytdRule = (ymd: string) => chainDailyPct(points, chainPeriodStartYmd("year", ymd), ymd);

  it("serves each monthly row the YTD window's compound at its date, and the yearly row its last month's", () => {
    const monthly = [
      { as_of_date: "2025-12-31", pct_month: null, nominal_pl: 1, net_capital_flow: 0, stock_units_inflow: 0, ytd_nominal_pl: 1, cumulative_nominal_pl: 1 },
      { as_of_date: "2026-01-31", pct_month: null, nominal_pl: 1, net_capital_flow: 0, stock_units_inflow: 0, ytd_nominal_pl: 1, cumulative_nominal_pl: 2 },
      { as_of_date: "2026-02-28", pct_month: null, nominal_pl: 1, net_capital_flow: 0, stock_units_inflow: 0, ytd_nominal_pl: 2, cumulative_nominal_pl: 3 },
      { as_of_date: "2026-03-03", pct_month: null, nominal_pl: 1, net_capital_flow: 0, stock_units_inflow: 0, ytd_nominal_pl: 3, cumulative_nominal_pl: 4 },
    ];
    const out = withDailyChainedMonthPct(monthly, points);
    expect(out[0]!.ytd_pct).toBeCloseTo(0.5, 12);
    expect(out[1]!.ytd_pct).toBeCloseTo(0.1, 12);
    expect(out[2]!.ytd_pct).toBeCloseTo(1.1 * 0.95 - 1, 12);
    expect(out[3]!.ytd_pct).toBeCloseTo(1.1 * 0.95 * 1.02 - 1, 12);
    for (const r of out) expect(r.ytd_pct).toBeCloseTo(ytdRule(r.as_of_date)!, 12);
    const yearly = rollupMonthlyPerfYearly(out);
    expect(yearly[0]!.as_of_date).toBe("2026-12-31");
    expect(yearly[0]!.ytd_pct).toBeCloseTo(ytdRule("2026-03-03")!, 12);
  });

  it("reads null for a row whose year has no daily return", () => {
    const out = withDailyChainedMonthPct([{ as_of_date: "2024-06-30", pct_month: null }], points);
    expect(out[0]!.ytd_pct).toBeNull();
  });

  it("serves each daily point the YTD window's compound from the full history, whatever the window", () => {
    const windowed = [{ as_of_date: "2026-02-27", pl: 1 }, { as_of_date: "2026-03-03", pl: 2 }, { as_of_date: "2026-02-10", pl: 3 }];
    const out = withDailyYtdPct(windowed, points);
    expect(out.map((p) => p.pl)).toEqual([1, 2, 3]);
    for (const p of out) expect(p.ytd_pct).toBeCloseTo(ytdRule(p.as_of_date)!, 12);
    // A day the full series lacks reads the rule directly; a year with no return reads null.
    expect(withDailyYtdPct([{ as_of_date: "2026-02-15" }], points)[0]!.ytd_pct).toBeCloseTo(0.1, 12);
    expect(withDailyYtdPct([{ as_of_date: "2024-01-05" }], points)[0]!.ytd_pct).toBeNull();
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
