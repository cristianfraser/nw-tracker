import { describe, expect, it } from "vitest";
import { getGroupConsolidatedTables } from "./groupConsolidatedTables.js";
import {
  shortHorizonCellFromLegs,
  withShortHorizonCells,
} from "./periodReturnsShortHorizon.js";
import type { PeriodReturnsPayload } from "./periodReturns.js";

describe("shortHorizonCellFromLegs (pure flow-adjusted math)", () => {
  it("computes a plain return when there is no flow", () => {
    const c = shortHorizonCellFromLegs("d1", 1100, 1000, 0, "2026-07-06");
    expect(c.pct).toBeCloseTo(0.1, 12);
    expect(c.nominal_pl).toBeCloseTo(100, 9);
    expect(c.annualized_pct).toBeNull();
    expect(c.window_start_date).toBe("2026-07-06");
  });

  it("flow-adjusts: a deposit that fully explains the rise is a 0% return, not a gain", () => {
    const c = shortHorizonCellFromLegs("d1", 1050, 1000, 50, "2026-07-06");
    expect(c.nominal_pl).toBeCloseTo(0, 9);
    expect(c.pct).toBeCloseTo(0, 12);
  });

  it("divides by (V_start + flow), not V_start alone", () => {
    const c = shortHorizonCellFromLegs("w1", 1100, 1000, 50, "2026-06-30");
    expect(c.nominal_pl).toBeCloseTo(50, 9);
    expect(c.pct).toBeCloseTo(50 / 1050, 12);
  });

  it("returns a null cell when a leg is missing (no fabricated 0%)", () => {
    const c = shortHorizonCellFromLegs("d1", null, 1000, 0, "2026-07-06");
    expect(c.pct).toBeNull();
    expect(c.nominal_pl).toBeNull();
    expect(c.months).toBe(0);
  });

  it("returns null pct when the denominator is ~0", () => {
    const c = shortHorizonCellFromLegs("d1", 0, 0, 0, "2026-07-06");
    expect(c.pct).toBeNull();
  });
});

describe("withShortHorizonCells (assembler)", () => {
  const monthly: PeriodReturnsPayload = {
    unit: "clp",
    as_of_date: "2026-07-07",
    mtd_is_live: true,
    first_month: "2020-01",
    periods: [
      { period: "mtd", pct: 0.01, nominal_pl: 10, annualized_pct: null, months: 1, window_start_month: "2026-07" },
      { period: "ytd", pct: 0.05, nominal_pl: 50, annualized_pct: null, months: 7, window_start_month: "2026-01" },
      { period: "y1", pct: 0.1, nominal_pl: 100, annualized_pct: null, months: 12, window_start_month: "2025-08" },
      { period: "y3", pct: 0.3, nominal_pl: 300, annualized_pct: 0.09, months: 36, window_start_month: "2023-08" },
      { period: "y5", pct: 0.5, nominal_pl: 500, annualized_pct: 0.08, months: 60, window_start_month: "2021-08" },
      { period: "total", pct: 1, nominal_pl: 1000, annualized_pct: 0.11, months: 78, window_start_month: "2020-01" },
    ],
  };

  it("passes a null payload through", () => {
    expect(withShortHorizonCells(null, [], "clp")).toBeNull();
  });

  it("prepends d1/w1 so the full order leads with the short-horizon cells", () => {
    const out = withShortHorizonCells(monthly, [], "clp")!;
    expect(out.periods.map((c) => c.period)).toEqual([
      "d1",
      "w1",
      "mtd",
      "ytd",
      "y1",
      "y3",
      "y5",
      "total",
    ]);
    // Empty account list → null-valued short-horizon cells, monthly cells preserved.
    expect(out.periods[0]!.pct).toBeNull();
    expect(out.periods[2]!.pct).toBeCloseTo(0.01, 12);
  });
});

describe("computeShortHorizonReturnCells (integration, synthetic DB)", () => {
  it("returns two ordered cells for a real investment group", () => {
    const brokerage = getGroupConsolidatedTables("brokerage", "clp");
    if (brokerage.consolidated_monthly.length === 0) return; // synthetic DB without brokerage data
    const pr = brokerage.period_returns!;
    expect(pr.periods.slice(0, 2).map((c) => c.period)).toEqual(["d1", "w1"]);
    // Short-horizon cells carry a prior-anchor date (or null), never a month key.
    for (const c of pr.periods.slice(0, 2)) {
      expect(c.window_start_month).toBeNull();
      expect(c.annualized_pct).toBeNull();
    }
  });
});
