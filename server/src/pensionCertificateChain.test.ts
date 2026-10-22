import { describe, expect, it } from "vitest";
import type { PensionMovement } from "nw-tracker-contracts";
import {
  fundChain,
  fundHeldWindows,
  locateCertificateRows,
  pairFundSwitches,
  type OfficialSeriesByAfp,
} from "./pensionCertificateChain.js";

// March 2030: the 4th is a Monday; every date below is a weekday. Display lag 1.
const alpha = [
  ["2030-03-04", 99], ["2030-03-05", 100], ["2030-03-06", 101], ["2030-03-07", 102],
  ["2030-03-08", 103], ["2030-03-11", 104], ["2030-03-12", 105], ["2030-03-13", 150],
].map(([day, v]) => ({ day: day as string, unit_value_clp: v as number }));
const beta = [
  ["2030-03-04", 200], ["2030-03-05", 201], ["2030-03-06", 202], ["2030-03-07", 203],
  ["2030-03-08", 204], ["2030-03-11", 205], ["2030-03-12", 206], ["2030-03-13", 207],
  ["2030-03-14", 150],
].map(([day, v]) => ({ day: day as string, unit_value_clp: v as number }));
const byAfp: OfficialSeriesByAfp = new Map([["alpha", alpha], ["beta", beta]]);

function row(over: Partial<PensionMovement> & Pick<PensionMovement, "code" | "valor_cuota" | "cuotas">): PensionMovement {
  return {
    period: "2030-02",
    direction: "credit",
    description: `code ${over.code}`,
    employer_rut: null,
    fund: "A",
    pesos: Math.round(over.cuotas * over.valor_cuota),
    ...over,
  };
}

const contributionAlpha = row({ code: "110101", valor_cuota: 100, cuotas: 10 });
const egresoAlpha = row({ code: "120700", direction: "debit", period: "2030-03", valor_cuota: 103, cuotas: 10 });
const ingresoBeta = row({ code: "110710", period: "2030-03", valor_cuota: 205, cuotas: 5.02, pesos: 1029 });
const contributionBeta = row({ code: "110101", period: "2030-03", valor_cuota: 207, cuotas: 2 });
const certificate = [contributionBeta, ingresoBeta, egresoAlpha, contributionAlpha];

describe("locateCertificateRows", () => {
  it("names each row's AFP and official day from its valor cuota", () => {
    const located = locateCertificateRows(certificate, byAfp);
    expect(located.map((r) => [r.code, r.afp, r.official_day])).toEqual([
      ["110101", "beta", "2030-03-13"],
      ["110710", "beta", "2030-03-11"],
      ["120700", "alpha", "2030-03-08"],
      ["110101", "alpha", "2030-03-05"],
    ]);
  });

  it("throws on a value no AFP printed, one two AFPs printed, or pesos off the cuotas", () => {
    expect(() => locateCertificateRows([row({ code: "110101", valor_cuota: 999, cuotas: 1 })], byAfp)).toThrow(/no official matches/);
    expect(() => locateCertificateRows([row({ code: "110101", valor_cuota: 150, cuotas: 1 })], byAfp)).toThrow(/several official matches/);
    expect(() => locateCertificateRows([row({ code: "110101", valor_cuota: 100, cuotas: 10, pesos: 1100 })], byAfp)).toThrow(/pesos ≠/);
  });
});

describe("pairFundSwitches", () => {
  it("pairs the egreso with the ingreso that follows it, with ratio and pesos gap", () => {
    const [s, ...rest] = pairFundSwitches(locateCertificateRows(certificate, byAfp));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ from: "alpha", to: "beta", pesos_gap: 1029 - 1030 });
    expect(s!.ratio).toBeCloseTo(0.502, 9);
    expect(s!.out.official_day).toBe("2030-03-08");
    expect(s!.in.official_day).toBe("2030-03-11");
  });

  it("refuses an unpaired transfer, a pair inside one AFP, and an ingreso before its egreso", () => {
    const located = locateCertificateRows(certificate, byAfp);
    expect(() => pairFundSwitches(located.filter((r) => r.code !== "110710"))).toThrow(/do not pair/);
    const sameAfp = locateCertificateRows(
      [egresoAlpha, row({ code: "110710", period: "2030-03", valor_cuota: 104, cuotas: 10 })],
      byAfp
    );
    expect(() => pairFundSwitches(sameAfp)).toThrow(/out → in/);
    const reversed = locateCertificateRows(
      [row({ code: "110710", valor_cuota: 100, cuotas: 10 }), row({ code: "120700", direction: "debit", period: "2030-03", valor_cuota: 207, cuotas: 10 })],
      byAfp
    );
    expect(() => pairFundSwitches(reversed)).toThrow(/out → in/);
  });
});

describe("fundChain", () => {
  it("lists the funds in holding order with their own rows and nets each sold fund to its egreso", () => {
    const located = locateCertificateRows(certificate, byAfp);
    const legs = fundChain(located, pairFundSwitches(located));
    expect(legs.map((l) => [l.afp, l.rows.length, l.net_cuotas, l.switch_in?.from ?? null, l.switch_out?.to ?? null])).toEqual([
      ["alpha", 1, 10, null, "beta"],
      ["beta", 1, 2, "alpha", null],
    ]);
  });

  it("throws when a sold fund's rows do not add up to what it sold, or a row is priced after its egreso", () => {
    const short = locateCertificateRows([row({ code: "110101", valor_cuota: 100, cuotas: 9 }), egresoAlpha, ingresoBeta], byAfp);
    expect(() => fundChain(short, pairFundSwitches(short))).toThrow(/rows net 9.00 \+ 0 transferred in ≠ 10/);
    const late = locateCertificateRows(
      [contributionAlpha, egresoAlpha, ingresoBeta, row({ code: "110101", period: "2030-03", valor_cuota: 105, cuotas: 0.001, pesos: 0 })],
      byAfp
    );
    expect(() => fundChain(late, pairFundSwitches(late))).toThrow(/priced 2030-03-12, after its transfer out/);
  });

  it("refuses a row priced at a fund the chain never held", () => {
    const stray = locateCertificateRows([contributionAlpha, egresoAlpha, ingresoBeta], new Map([...byAfp, ["gamma", [{ day: "2030-03-05", unit_value_clp: 55 }]]]));
    const withStray = [...stray, { ...stray[0]!, afp: "gamma", official_day: "2030-03-05" }];
    expect(() => fundChain(withStray, pairFundSwitches(withStray))).toThrow(/gamma, a fund the chain never held/);
  });
});

describe("fundHeldWindows", () => {
  it("holds each fund from its first visible row through the visible day of its sale", () => {
    const located = locateCertificateRows(certificate, byAfp);
    const legs = fundChain(located, pairFundSwitches(located));
    expect(fundHeldWindows(legs, 1)).toEqual([
      // alpha's contribution shows 03-06 (official 03-05); its sale price shows 03-11 (official 03-08).
      { afp: "alpha", from_day: "2030-03-06", through_day: "2030-03-11" },
      // beta's first row is the ingreso, shown 03-12 (official 03-11); still held.
      { afp: "beta", from_day: "2030-03-12", through_day: null },
    ]);
  });

  it("throws when a fund's row shows before its switch in", () => {
    const early = locateCertificateRows(
      [contributionAlpha, egresoAlpha, ingresoBeta, row({ code: "110101", valor_cuota: 203, cuotas: 1 })],
      byAfp
    );
    const legs = fundChain(early, pairFundSwitches(early));
    expect(() => fundHeldWindows(legs, 1)).toThrow(/shows on 2030-03-08, before its switch in on 2030-03-12/);
  });
});
