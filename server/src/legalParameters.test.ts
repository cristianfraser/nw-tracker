import { describe, expect, it } from "vitest";
import {
  boletaRetentionRate,
  igcMarginalRate,
  igcTax,
  iuscTax,
  monthlyGratificationClp,
  pensionCapUf,
  roundReajustePct,
  unemploymentCapUf,
} from "./legalParameters.js";
import { f22Code170, f22Code305, f22IdentityViolations } from "./f22Identities.js";
import { decemberReajuste, ipcReajuste, type OfficialIpcLookup } from "./siiOfficialIpc.js";
import { mortgageCuotaWindow } from "./mortgageCuotaDay.js";

const UTA = 800_000;

describe("legal parameters", () => {
  it("gives the marginal IGC rate of every bracket, the 35 % and 40 % ones included", () => {
    expect(igcMarginalRate(10 * UTA, UTA, 2026)).toBe(0);
    expect(igcMarginalRate(100 * UTA, UTA, 2026)).toBe(0.304);
    expect(igcMarginalRate(200 * UTA, UTA, 2026)).toBe(0.35);
    expect(igcMarginalRate(400 * UTA, UTA, 2026)).toBe(0.4);
    // AT2018–AT2020 stop at 35 %.
    expect(igcMarginalRate(400 * UTA, UTA, 2019)).toBe(0.35);
    expect(() => igcMarginalRate(UTA, UTA, 2017)).toThrow(/no table/);
  });

  it("computes the monthly impuesto único with the income year's table in UTM", () => {
    expect(iuscTax(50 * 60_000, 60_000, 2025)).toBe(igcTax(50 * 60_000, 60_000, 2026));
  });

  it("throws for a year its dated tables do not list", () => {
    expect(pensionCapUf(2026)).toBe(89.9);
    expect(unemploymentCapUf(2026)).toBe(134.9);
    expect(() => pensionCapUf(2099)).toThrow(/no pension cap for 2099/);
    expect(() => monthlyGratificationClp(1_000_000, 2099)).toThrow(/no minimum wage/);
  });

  it("caps the legal gratification at 4,75 minimum wages a year", () => {
    expect(monthlyGratificationClp(400_000, 2025)).toBe(100_000);
    expect(monthlyGratificationClp(4_000_000, 2025)).toBe(Math.round((4.75 * 529_000) / 12));
  });

  it("follows the boleta retention schedule to its permanent 17 %", () => {
    expect(boletaRetentionRate(2019)).toBe(0.1);
    expect(boletaRetentionRate(2026)).toBe(0.1525);
    expect(boletaRetentionRate(2030)).toBe(0.17);
  });
});

describe("the IPC reajuste", () => {
  const lookup: OfficialIpcLookup = (m) =>
    ({
      "2025-01-01": { variationPct: 0, indexPoints: 100 },
      "2025-02-01": { variationPct: 1.04, indexPoints: 101.04 },
      "2025-03-01": { variationPct: -0.5, indexPoints: 100.53 },
    })[m] ?? null;

  it("rounds to the SII's decimal and, for year-end factors, never goes below zero", () => {
    const r = ipcReajuste({ round: true, lookup, latestMonth: "2025-03-01" });
    expect(r.pct("2025-01-01", "2025-02-01")).toBe(1);
    expect(r.pct("2025-02-01", "2025-03-01")).toBe(roundReajustePct((100.53 / 101.04 - 1) * 100));
    expect(r.yearEndPct("2025-02-01", "2025-03-01")).toBe(0);
    expect(r.yearEndPct("2025-03-01", "2025-02-01")).toBe(0);
    // A month after the latest published one reads as the latest.
    expect(r.pct("2025-01-01", "2025-06-01")).toBe(r.pct("2025-01-01", "2025-03-01"));
  });

  it("runs the year-end reajuste to November, or provisionally to the latest month", () => {
    expect(decemberReajuste(2025, "2025-12-01")).toEqual({ toMonth: "2025-11-01", provisional: false });
    expect(decemberReajuste(2025, "2025-09-01")).toEqual({ toMonth: "2025-09-01", provisional: true });
  });
});

describe("F22 identities", () => {
  it("computes and checks 170 and 305 the same way", () => {
    const codes = new Map([
      [158, 10_000],
      [750, 1_000],
      [170, 9_000],
      [304, 500],
      [1830, 20],
      [198, 100],
      [900, 30],
      [305, 450],
    ]);
    expect(f22Code170(codes)).toBe(9_000);
    expect(f22Code305(Object.fromEntries(codes))).toBe(450);
    expect(f22IdentityViolations(codes, "test")).toEqual([]);
    codes.set(305, 451);
    expect(f22IdentityViolations(codes, "test")).toEqual(["305 = 304 + 1830 − 198 + 900 (451 vs 450)"]);
    codes.delete(304);
    expect(() => f22IdentityViolations(codes, "test")).toThrow(/code 304 missing/);
  });
});

describe("the mortgage cuota window", () => {
  it("opens on the cuota day and closes the day before the next cycle's", () => {
    expect(mortgageCuotaWindow("2026-12")).toEqual({ start: "2026-12-11", end: "2027-01-10" });
  });
});
