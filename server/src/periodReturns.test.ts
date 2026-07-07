import { describe, expect, it } from "vitest";
import {
  computePeriodReturns,
  PERIOD_RETURN_ORDER,
  type PeriodReturnInputRow,
  type PeriodReturnKey,
  type PeriodReturnsPayload,
} from "./periodReturns.js";

/** Month-end row for `YYYY-MM`. */
function row(monthKey: string, pct: number | null, nominal: number | null): PeriodReturnInputRow {
  const [y, m] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { as_of_date: lastDay, pct_month: pct, nominal_pl: nominal };
}

/** Consecutive month-end rows starting at `startKey` (asc), one per pct value. */
function series(startKey: string, pcts: (number | null)[]): PeriodReturnInputRow[] {
  let [y, m] = startKey.split("-").map(Number);
  return pcts.map((p) => {
    const mk = `${y}-${String(m).padStart(2, "0")}`;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    return row(mk, p, p == null ? null : p * 1000);
  });
}

function cell(payload: PeriodReturnsPayload, key: PeriodReturnKey) {
  return payload.periods.find((c) => c.period === key)!;
}

describe("computePeriodReturns", () => {
  it("returns null for empty input", () => {
    expect(computePeriodReturns([], "clp", "2026-07-07")).toBeNull();
  });

  it("keeps the fixed period order regardless of input sort order", () => {
    const rows = series("2026-01", [0.01, 0.02, 0.03]);
    const payload = computePeriodReturns([...rows].reverse(), "clp", "2026-03-15")!;
    expect(payload.periods.map((c) => c.period)).toEqual([...PERIOD_RETURN_ORDER]);
    expect(payload.unit).toBe("clp");
    expect(payload.first_month).toBe("2026-01");
  });

  it("MTD reads the current-month row and marks it live", () => {
    const payload = computePeriodReturns(series("2026-01", [0.01, 0.02, 0.03]), "clp", "2026-03-15")!;
    expect(payload.mtd_is_live).toBe(true);
    expect(cell(payload, "mtd").pct).toBeCloseTo(0.03, 12);
    expect(cell(payload, "mtd").months).toBe(1);
  });

  it("chains YTD and Total geometrically from monthly pct", () => {
    const payload = computePeriodReturns(series("2026-01", [0.01, 0.02, 0.03]), "clp", "2026-03-15")!;
    const expected = 1.01 * 1.02 * 1.03 - 1;
    expect(cell(payload, "ytd").pct).toBeCloseTo(expected, 12);
    expect(cell(payload, "total").pct).toBeCloseTo(expected, 12);
    // nominal is summed over the window (0.01*1000 + 0.02*1000 + 0.03*1000)
    expect(cell(payload, "ytd").nominal_pl).toBeCloseTo(60, 9);
  });

  it("anchors trailing windows to the current month (1A = anchor + 11 prior)", () => {
    // 24 months ending 2026-07
    const payload = computePeriodReturns(series("2024-08", Array(24).fill(0.001)), "clp", "2026-07-07")!;
    const y1 = cell(payload, "y1");
    expect(y1.months).toBe(12);
    expect(y1.window_start_month).toBe("2025-08");
  });

  it("returns null (not a shorter chain) when a window predates the series start", () => {
    // 19 months → enough for 1A but not 3A/5A
    const payload = computePeriodReturns(series("2025-01", Array(19).fill(0.005)), "clp", "2026-07-07")!;
    expect(cell(payload, "y1").pct).not.toBeNull();
    expect(cell(payload, "y3").pct).toBeNull();
    expect(cell(payload, "y3").months).toBe(0);
    expect(cell(payload, "y5").pct).toBeNull();
  });

  it("treats a null pct_month as factor 1 but still sums its nominal", () => {
    const rows = [row("2026-01", 0.05, 500), row("2026-02", null, 300), row("2026-03", 0.02, 200)];
    const payload = computePeriodReturns(rows, "clp", "2026-03-15")!;
    expect(cell(payload, "ytd").pct).toBeCloseTo(1.05 * 1.02 - 1, 12);
    expect(cell(payload, "ytd").nominal_pl).toBeCloseTo(1000, 9);
    expect(cell(payload, "ytd").months).toBe(3);
  });

  it("yields pct null (never a fabricated 0%) when every row in the window has null pct", () => {
    const rows = [row("2026-01", null, 500), row("2026-02", null, 300)];
    const payload = computePeriodReturns(rows, "clp", "2026-02-15")!;
    expect(cell(payload, "ytd").pct).toBeNull();
    expect(cell(payload, "ytd").nominal_pl).toBeCloseTo(800, 9);
  });

  it("skips a missing interior month within a covered window", () => {
    const rows = [row("2026-01", 0.01, 100), row("2026-03", 0.02, 200)]; // Feb missing
    const payload = computePeriodReturns(rows, "clp", "2026-03-10")!;
    const ytd = cell(payload, "ytd");
    expect(ytd.months).toBe(2);
    expect(ytd.window_start_month).toBe("2026-01");
    expect(ytd.pct).toBeCloseTo(1.01 * 1.02 - 1, 12);
  });

  it("marks MTD not-live when no row exists for the current month", () => {
    const payload = computePeriodReturns(series("2026-01", [0.01, 0.02, 0.03]), "clp", "2026-07-07")!;
    expect(payload.mtd_is_live).toBe(false);
    expect(cell(payload, "mtd").pct).toBeNull();
    expect(cell(payload, "mtd").months).toBe(0);
    // Other windows still anchor at the current month and chain the existing rows.
    expect(cell(payload, "total").pct).toBeCloseTo(1.01 * 1.02 * 1.03 - 1, 12);
  });

  it("throws on duplicate month keys (fail fast)", () => {
    const rows = [row("2026-01", 0.01, 100), row("2026-01", 0.02, 200)];
    expect(() => computePeriodReturns(rows, "clp", "2026-01-31")).toThrow(/duplicate month key/);
  });

  it("annualizes only windows longer than 12 months", () => {
    // 36 consecutive months of +2%, ending 2026-07
    const payload = computePeriodReturns(series("2023-08", Array(36).fill(0.02)), "clp", "2026-07-07")!;
    const y3 = cell(payload, "y3");
    expect(y3.pct).toBeCloseTo(Math.pow(1.02, 36) - 1, 9);
    // (1.02^36)^(12/36) - 1 == 1.02^12 - 1
    expect(y3.annualized_pct).toBeCloseTo(Math.pow(1.02, 12) - 1, 9);
    expect(cell(payload, "y1").annualized_pct).toBeNull();
    expect(cell(payload, "ytd").annualized_pct).toBeNull();
    expect(cell(payload, "mtd").annualized_pct).toBeNull();
  });

  it("total is annualized only when history exceeds 12 months", () => {
    const short = computePeriodReturns(series("2025-08", Array(12).fill(0.01)), "clp", "2026-07-07")!;
    expect(cell(short, "total").annualized_pct).toBeNull(); // exactly 12 elapsed
    const long = computePeriodReturns(series("2025-07", Array(13).fill(0.01)), "clp", "2026-07-07")!;
    expect(cell(long, "total").annualized_pct).not.toBeNull(); // 13 elapsed
  });
});
