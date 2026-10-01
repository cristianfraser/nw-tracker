import { describe, expect, it } from "vitest";
import type { PensionAccountCertificatesPayload, PensionMovement } from "nw-tracker-contracts";
import { planPensionCertificates, type PensionLedgerRow } from "./pensionAccountCertificatesApply.js";

const EMPLOYER = "11.111.111-1";
const INSURER = "22.222.222-2";

function mv(period: string, direction: "credit" | "debit", code: string, pesos: number, cuotas: number, valor: number, rut = EMPLOYER): PensionMovement {
  return { period, direction, code, description: `code ${code}`, pesos, cuotas, valor_cuota: valor, employer_rut: rut, fund: "A" };
}

function payload(movements: PensionMovement[], balance: number): PensionAccountCertificatesPayload {
  return {
    provider: "afp_uno",
    product: "mandatory",
    fund: "A",
    apply: true,
    read_at: "2030-07-20T01:00:00Z",
    balance: { cuotas: balance, valor_cuota: 1000, pesos: Math.round(balance * 1000) },
    recent_movements: [],
    contributions: {
      folio: "F1",
      issued_on: "2030-07-19",
      from_period: "2030-03",
      to_period: "2030-07",
      rows: [
        { period: "2030-03", description: "COTIZACION NORMAL", paid_on: "2030-04-10", pesos: 50_000, cuotas: 50, valor_cuota: 1000, payer_rut: EMPLOYER, fund: "A" },
        { period: "2030-04", description: "COTIZACION NORMAL", paid_on: "2030-05-12", pesos: 40_400, cuotas: 40, valor_cuota: 1010, payer_rut: EMPLOYER, fund: "A" },
      ],
    },
    movements: { folio: "F2", issued_on: "2030-07-19", from_period: "2030-03", to_period: "2030-07", rows: movements },
  };
}

const MOVEMENTS = [
  mv("2030-03", "credit", "110101", 50_000, 50, 1000),
  // A commission's debit and credit cancel; a catch-up rentabilidad row with cuotas remains.
  mv("2030-03", "debit", "120506", 1_000, 1, 1000),
  mv("2030-03", "credit", "111200", 1_000, 1, 1000),
  mv("2030-03", "credit", "110974", 150, 0.15, 1000),
  mv("2030-04", "credit", "110101", 40_400, 40, 1010),
  mv("2030-05", "credit", "111138", 20_400, 20, 1020, INSURER),
];
const SERIES = [
  { day: "2030-05-12", unit_value_clp: 1015 },
  { day: "2030-05-20", unit_value_clp: 1020 },
];
const LEDGER: PensionLedgerRow[] = [
  { id: 1, occurred_on: "2029-12-10", amount: 100_000, units_delta: 100 },
  { id: 2, occurred_on: "2030-04-10", amount: 50_000, units_delta: 50 },
];

describe("planPensionCertificates", () => {
  it("dates a contribution by fecha caja, an insurance one by its valor cuota's day, and nets the rest per período", () => {
    const plan = planPensionCertificates(payload(MOVEMENTS, 210.15), LEDGER, SERIES);
    expect(plan.problems).toEqual([]);
    expect(plan.rows.map((r) => [r.kind, r.occurred_on, r.pesos, r.cuotas, r.state, r.movement_id])).toEqual([
      ["contribution", "2030-04-10", 50_000, 50, "present", 2],
      ["adjustment", "2030-04-10", 150, 0.15, "new", null],
      ["contribution", "2030-05-12", 40_400, 40, "new", null],
      ["insurance_contribution", "2030-05-20", 20_400, 20, "new", null],
    ]);
    expect(plan.ledger_cuotas_after).toBe(210.15);
  });

  it("leaves an insurance contribution pending while its valor cuota is not in the series", () => {
    const plan = planPensionCertificates(payload(MOVEMENTS, 999), LEDGER, SERIES.slice(0, 1));
    const pending = plan.rows.filter((r) => r.state === "pending");
    expect(pending.map((r) => [r.kind, r.occurred_on])).toEqual([["insurance_contribution", null]]);
    // The stated balance is not checked while a row is pending.
    expect(plan.problems).toEqual([]);
  });

  it("fails when the ledger total would not be the stated balance", () => {
    const plan = planPensionCertificates(payload(MOVEMENTS, 211), LEDGER, SERIES);
    expect(plan.problems).toEqual(["the ledger would hold 210.15 cuotas; the fund manager states 211.00"]);
  });

  it("fails on a ledger row inside the window that the certificate does not list", () => {
    const ledger = [...LEDGER, { id: 3, occurred_on: "2030-05-15", amount: 5_000, units_delta: 5 }];
    const plan = planPensionCertificates(payload(MOVEMENTS, 215.15), ledger, SERIES);
    expect(plan.problems).toEqual(["movement 3 (2030-05-15, 5 cuotas) is inside the certificate's window but not on it"]);
  });

  it("fails on a present row whose pesos differ, and on a withdrawal", () => {
    const ledger = [LEDGER[0]!, { ...LEDGER[1]!, amount: 49_999 }];
    const withdrawal = [...MOVEMENTS, mv("2030-06", "debit", "122774", 10_000, 10, 1000, EMPLOYER)];
    const plan = planPensionCertificates(payload(withdrawal, 210.15), ledger, SERIES);
    expect(plan.rows.find((r) => r.movement_id === 2)?.state).toBe("conflict");
    expect(plan.problems).toEqual([
      "período 2030-06: a withdrawal (code 122774) — enter it by hand with the bank's date",
      "período 2030-03 contribution on 2030-04-10: certificate 50000 pesos, the ledger has 49999 pesos (movement 2)",
    ]);
  });

  it("fails on a contribution the contributions certificate does not list", () => {
    const moves = [...MOVEMENTS, mv("2030-06", "credit", "110101", 30_000, 30, 1000)];
    const plan = planPensionCertificates(payload(moves, 210.15), LEDGER, SERIES);
    expect(plan.problems).toEqual(["período 2030-06: the contribution of 30000 pesos (30 cuotas) is not on the contributions certificate"]);
  });
});
