import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { fxMonthEndForBalanceUsd, fxRowOnOrBefore } from "./fxRates.js";

// Isolated fixture window centuries before any real fx_daily data (Yahoo series starts 2016+,
// other fixtures use 2020+/2099 dates), so on-or-before/-after lookups are deterministic.
const FIXTURE_ROWS: ReadonlyArray<[date: string, clpPerUsd: number]> = [
  ["1700-01-15", 700],
  ["1700-01-31", 710], // month-end
  ["1700-02-10", 720],
];

beforeAll(() => {
  const ins = db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
  for (const [date, clp] of FIXTURE_ROWS) ins.run(date, clp);
});

afterAll(() => {
  db.prepare(`DELETE FROM fx_daily WHERE date LIKE '17%'`).run();
});

describe("fxRowOnOrBefore", () => {
  it("returns the latest row on or before the date", () => {
    expect(fxRowOnOrBefore("1700-02-12")).toEqual({ date: "1700-02-10", clp_per_usd: 720 });
    expect(fxRowOnOrBefore("1700-02-10")).toEqual({ date: "1700-02-10", clp_per_usd: 720 });
  });

  it("monthEndOnly skips non-month-end rows", () => {
    expect(fxRowOnOrBefore("1700-02-12", { monthEndOnly: true })).toEqual({
      date: "1700-01-31",
      clp_per_usd: 710,
    });
  });

  it("monthEndOnly falls back to any row when no month-end exists on or before", () => {
    expect(fxRowOnOrBefore("1700-01-20", { monthEndOnly: true })).toEqual({
      date: "1700-01-15",
      clp_per_usd: 700,
    });
  });

  it("returns null before the series starts and for null dates", () => {
    expect(fxRowOnOrBefore("1699-12-31")).toBeNull();
    expect(fxRowOnOrBefore(null)).toBeNull();
  });
});

describe("fxMonthEndForBalanceUsd", () => {
  it("prefers the on-or-before observado row", () => {
    expect(fxMonthEndForBalanceUsd("1700-02-12")).toEqual({
      date: "1700-02-10",
      clp_per_usd: 720,
    });
  });

  it("falls forward to the earliest month-end when the series starts after the date", () => {
    // No row on or before 1699-06-01 anywhere in fx_daily; the earliest month-end row in the
    // table is the 1700-01-31 fixture.
    expect(fxMonthEndForBalanceUsd("1699-06-01")).toEqual({
      date: "1700-01-31",
      clp_per_usd: 710,
    });
  });

  it("returns null for null dates", () => {
    expect(fxMonthEndForBalanceUsd(null)).toBeNull();
  });
});
