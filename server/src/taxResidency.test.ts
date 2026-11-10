import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  declareTaxResidency,
  deleteTaxResidencyPeriod,
  listTaxResidencyPeriods,
  residencyForIncomeYear,
  taxResidencyOn,
  type TaxResidencyPeriod,
} from "./taxResidency.js";

// Pure readers over hand-made periods: no rows written.
const periods: TaxResidencyPeriod[] = [
  { id: 1, jurisdiction: "cl", fromDate: "1995-04-17", toDate: "2024-04-14", note: null, createdAt: "x" },
  { id: 2, jurisdiction: "us", fromDate: "2024-04-15", toDate: null, note: null, createdAt: "x" },
];

describe("taxResidencyOn / residencyForIncomeYear", () => {
  it("reads the covering period, and Chile (undeclared) when none covers the day", () => {
    expect(taxResidencyOn("2024-04-14", periods)).toMatchObject({ jurisdiction: "cl", declared: true });
    expect(taxResidencyOn("2024-04-15", periods)).toMatchObject({ jurisdiction: "us", declared: true });
    expect(taxResidencyOn("1990-01-01", periods)).toEqual({ jurisdiction: "cl", period: null, declared: false });
    expect(taxResidencyOn("2024-04-15", [])).toEqual({ jurisdiction: "cl", period: null, declared: false });
    expect(() => taxResidencyOn("2024-4-15", periods)).toThrow(/ISO/);
  });

  it("gives a full, none or split year, and the undeclared default", () => {
    expect(residencyForIncomeYear(2023, periods)).toMatchObject({ cl: "full", us: "none", declared: true });
    expect(residencyForIncomeYear(2024, periods)).toMatchObject({ cl: { through: "2024-04-14" }, us: { from: "2024-04-15" }, declared: true });
    expect(residencyForIncomeYear(2025, periods)).toMatchObject({ cl: "none", us: "full", declared: true });
    expect(residencyForIncomeYear(2025, [])).toEqual({ incomeYear: 2025, cl: "full", us: "none", declared: false, periods: [] });
    // A first period declared mid-year reads the undeclared months before it as Chile too.
    const usOnly: TaxResidencyPeriod[] = [{ id: 9, jurisdiction: "us", fromDate: "2030-07-01", toDate: null, note: null, createdAt: "x" }];
    expect(residencyForIncomeYear(2030, usOnly)).toMatchObject({ cl: { through: "2030-06-30" }, us: { from: "2030-07-01" } });
    expect(residencyForIncomeYear(2029, usOnly)).toMatchObject({ cl: "full", us: "none", declared: false });
  });

  it("refuses a return to Chile or two changes inside one year", () => {
    const back: TaxResidencyPeriod[] = [
      { id: 1, jurisdiction: "us", fromDate: "2030-01-01", toDate: "2030-05-31", note: null, createdAt: "x" },
      { id: 2, jurisdiction: "cl", fromDate: "2030-06-01", toDate: null, note: null, createdAt: "x" },
    ];
    expect(() => residencyForIncomeYear(2030, back)).toThrow(/only a departure/);
  });
});

describe("declareTaxResidency / deleteTaxResidencyPeriod", () => {
  const cleanup = () => db.prepare(`DELETE FROM tax_residency_periods`).run();
  beforeAll(cleanup);
  afterAll(cleanup);

  it("declares in order, closes the open period the day before, and deletes only the latest", () => {
    expect(listTaxResidencyPeriods()).toEqual([]);
    const cl = declareTaxResidency({ jurisdiction: "cl", fromDate: "2090-01-01", note: "  born  " });
    expect(cl).toMatchObject({ jurisdiction: "cl", fromDate: "2090-01-01", toDate: null, note: "born" });
    expect(() => declareTaxResidency({ jurisdiction: "cl", fromDate: "2091-01-01" })).toThrow(/already a cl/);
    expect(() => declareTaxResidency({ jurisdiction: "us", fromDate: "2089-01-01" })).toThrow(/after the latest/);
    expect(() => declareTaxResidency({ jurisdiction: "uk", fromDate: "2095-01-01" })).toThrow(/jurisdiction/);
    expect(() => declareTaxResidency({ jurisdiction: "us", fromDate: "2095/01/01" })).toThrow(/YYYY-MM-DD/);
    const us = declareTaxResidency({ jurisdiction: "us", fromDate: "2095-04-15", note: null });
    const all = listTaxResidencyPeriods();
    expect(all.map((p) => [p.jurisdiction, p.fromDate, p.toDate])).toEqual([
      ["cl", "2090-01-01", "2095-04-14"],
      ["us", "2095-04-15", null],
    ]);
    expect(residencyForIncomeYear(2095)).toMatchObject({ cl: { through: "2095-04-14" }, us: { from: "2095-04-15" } });
    // Only the latest can go; the one before reopens.
    expect(deleteTaxResidencyPeriod(cl.id)).toBe(false);
    expect(deleteTaxResidencyPeriod(us.id)).toBe(true);
    expect(listTaxResidencyPeriods().map((p) => p.toDate)).toEqual([null]);
    expect(deleteTaxResidencyPeriod(cl.id)).toBe(true);
    expect(listTaxResidencyPeriods()).toEqual([]);
  });
});
