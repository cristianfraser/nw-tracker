import { describe, expect, it } from "vitest";
import type { PensionMovement } from "nw-tracker-contracts";
import { firstVisibleDayOfValue, shapePensionLedgerRows, type DatedCertificateRow } from "./pensionLedgerShape.js";

function row(over: Partial<DatedCertificateRow> & Pick<PensionMovement, "code" | "pesos" | "cuotas">): DatedCertificateRow {
  return {
    period: "2018-05",
    direction: "credit",
    description: `code ${over.code}`,
    valor_cuota: 1000,
    employer_rut: null,
    fund: "A",
    day: "2018-06-12",
    factor: 1,
    ...over,
  };
}

describe("shapePensionLedgerRows", () => {
  it("converts an earlier fund's cuotas with the transfer ratio", () => {
    const { rows } = shapePensionLedgerRows([row({ code: "110101", pesos: 97_717, cuotas: 2.49, factor: 0.9065 })]);
    expect(rows).toEqual([{ kind: "contribution", periods: ["2018-05"], occurred_on: "2018-06-12", pesos: 97_717, cuotas: 2.2572 }]);
  });

  it("refuses a transfer row and provisions that do not cancel", () => {
    expect(() => shapePensionLedgerRows([row({ code: "110710", pesos: 1, cuotas: 1 })])).toThrow(/transfer between fund managers/);
    expect(() => shapePensionLedgerRows([row({ code: "122776", direction: "debit", pesos: 1, cuotas: 1 })])).toThrow(/do not cancel/);
  });
});

describe("firstVisibleDayOfValue", () => {
  const series = [
    { day: "2030-05-10", unit_value_clp: 10 },
    { day: "2030-05-11", unit_value_clp: 10 },
    { day: "2030-05-12", unit_value_clp: 11 },
    { day: "2030-05-20", unit_value_clp: 10 },
  ];
  it("returns the first day of the value's one run, and throws on two runs", () => {
    expect(firstVisibleDayOfValue(series, 10, "2030-05-01", "2030-05-15")).toBe("2030-05-10");
    expect(firstVisibleDayOfValue(series, 12, "2030-05-01", "2030-06-01")).toBeNull();
    expect(() => firstVisibleDayOfValue(series, 10, "2030-05-01", "2030-06-01")).toThrow(/2 separate runs/);
  });
});
