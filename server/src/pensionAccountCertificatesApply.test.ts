import { describe, expect, it } from "vitest";
import type { PensionAccountCertificatesPayload, PensionMovement } from "nw-tracker-contracts";
import { checkPensionStatedValue, planPensionCertificates, type PensionLedgerRow } from "./pensionAccountCertificatesApply.js";

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
        { period: "2030-04", description: "COTIZACION NORMAL", paid_on: "2030-05-10", pesos: 40_400, cuotas: 40, valor_cuota: 1010, payer_rut: EMPLOYER, fund: "A" },
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
// The display series, one row per calendar day: 1010 first shows on Monday 2030-05-13 and is
// carried over Friday's close into the weekend (a repeated value is one run, not an ambiguity).
const SERIES = [
  { day: "2030-04-12", unit_value_clp: 1000 },
  { day: "2030-04-13", unit_value_clp: 1000 },
  { day: "2030-04-14", unit_value_clp: 1001 },
  { day: "2030-05-13", unit_value_clp: 1010 },
  { day: "2030-05-14", unit_value_clp: 1010 },
  { day: "2030-05-15", unit_value_clp: 1010 },
  { day: "2030-05-22", unit_value_clp: 1020 },
];
const LEDGER: PensionLedgerRow[] = [
  { id: 1, occurred_on: "2029-12-10", amount: 100_000, units_delta: 100 },
  { id: 2, occurred_on: "2030-04-12", amount: 50_150, units_delta: 50.15 },
];

describe("planPensionCertificates", () => {
  it("dates every row by the day its price first shows, netting the rows of one day", () => {
    const plan = planPensionCertificates(payload(MOVEMENTS, 210.15), LEDGER, SERIES);
    expect(plan.problems).toEqual([]);
    expect(plan.rows.map((r) => [r.kind, r.occurred_on, r.pesos, r.cuotas, r.state, r.movement_id])).toEqual([
      ["contribution", "2030-04-12", 50_150, 50.15, "present", 2],
      ["contribution", "2030-05-13", 40_400, 40, "new", null],
      ["insurance_contribution", "2030-05-22", 20_400, 20, "new", null],
    ]);
    expect(plan.ledger_cuotas_after).toBe(210.15);
  });

  it("leaves a row pending while its price is not in the series", () => {
    const plan = planPensionCertificates(payload(MOVEMENTS, 999), LEDGER, SERIES.slice(0, 6));
    const pending = plan.rows.filter((r) => r.state === "pending");
    expect(pending.map((r) => [r.kind, r.occurred_on, r.cuotas])).toEqual([["adjustment", null, 20]]);
    // The stated balance is not checked while a row is pending.
    expect(plan.problems).toEqual([]);
  });

  it("fails when the ledger total would not be the stated balance", () => {
    const plan = planPensionCertificates(payload(MOVEMENTS, 211), LEDGER, SERIES);
    expect(plan.problems).toEqual(["the ledger would hold 210.1500 cuotas; the fund manager states 211.0000"]);
  });

  it("fails on a ledger row inside the window that the certificate does not list", () => {
    const ledger = [...LEDGER, { id: 3, occurred_on: "2030-05-15", amount: 5_000, units_delta: 5 }];
    const plan = planPensionCertificates(payload(MOVEMENTS, 215.15), ledger, SERIES);
    expect(plan.problems).toEqual(["movement 3 (2030-05-15, 5 cuotas) is inside the certificate's window but not on it"]);
  });

  it("fails on a present row whose pesos differ", () => {
    const ledger = [LEDGER[0]!, { ...LEDGER[1]!, amount: 50_149 }];
    const plan = planPensionCertificates(payload(MOVEMENTS, 210.15), ledger, SERIES);
    expect(plan.rows.find((r) => r.movement_id === 2)?.state).toBe("conflict");
    expect(plan.problems).toEqual([
      "período 2030-03 contribution on 2030-04-12: certificate 50150 pesos, the ledger has 50149 pesos (movement 2)",
    ]);
  });

  it("matches a withdrawal on its own row, its provisions cancelling, and never writes one", () => {
    const moves = [
      ...MOVEMENTS,
      mv("2030-05", "debit", "122776", 10_200, 10, 1020),
      mv("2030-05", "credit", "112777", 10_200, 10, 1020),
      mv("2030-05", "debit", "122774", 10_200, 10, 1020),
    ];
    const missing = planPensionCertificates(payload(moves, 200.15), LEDGER, SERIES);
    expect(missing.problems).toContain("período 2030-05: a withdrawal of 10 cuotas on 2030-05-22 is not in the ledger — enter it by hand");
    const ledger = [...LEDGER, { id: 4, occurred_on: "2030-05-22", amount: -10_200, units_delta: -10 }];
    const present = planPensionCertificates(payload(moves, 200.15), ledger, SERIES);
    expect(present.problems).toEqual([]);
    expect(present.rows.find((r) => r.kind === "withdrawal")).toMatchObject({ state: "present", movement_id: 4 });
  });

  it("fails on a contribution the contributions certificate does not list", () => {
    const moves = [...MOVEMENTS, mv("2030-06", "credit", "110101", 30_000, 30, 1001)];
    const plan = planPensionCertificates(payload(moves, 240.15), LEDGER, SERIES);
    expect(plan.problems).toEqual(["período 2030-06: the contribution of 30000 pesos (30 cuotas) is not on the contributions certificate"]);
  });
});

describe("checkPensionStatedValue", () => {
  const series = [
    { day: "2030-07-15", unit_value_clp: 1000 },
    { day: "2030-07-16", unit_value_clp: 1010.5 },
    { day: "2030-07-17", unit_value_clp: 1020.25 },
  ];
  const stated = { cuotas: 200, valor_cuota: 1010.5, pesos: 202_100 };

  it("matches when the app builds the website's pesos on the day that valor cuota shows", () => {
    const days: string[] = [];
    const r = checkPensionStatedValue(stated, series, "2030-07-17", (day) => {
      days.push(day);
      return 200 * 1010.5;
    });
    expect(days).toEqual(["2030-07-16"]);
    expect(r.problems).toEqual([]);
    expect(r.check.status).toBe("match");
  });

  it("pairs the website's value with the app's on the day it shows, whatever the read's hour", () => {
    // 2030-07-17 22:00: the app already shows 07-17's price, the website still 07-16's.
    const appValue = (day: string) => 200 * series.find((s) => s.day === day)!.unit_value_clp;
    const evening = checkPensionStatedValue(stated, series, "2030-07-17", appValue);
    expect(evening.check).toMatchObject({ status: "match", app_day: "2030-07-16" });
    // 2030-07-18 00:01: the website has caught up to 07-17's price.
    const night = checkPensionStatedValue({ cuotas: 200, valor_cuota: 1020.25, pesos: 204_050 }, series, "2030-07-18", appValue);
    expect(night.check).toMatchObject({ status: "match", app_day: "2030-07-17" });
  });

  it("flags a cuota residue worth more than a peso", () => {
    const r = checkPensionStatedValue(stated, series, "2030-07-17", () => 200.0002 * 1010.5 + 1);
    expect(r.check.status).toBe("mismatch");
    expect(r.problems[0]).toContain("the app builds 202101 on 2030-07-16");
  });

  it("waits while the app's series lacks the website's valor cuota", () => {
    const r = checkPensionStatedValue({ ...stated, valor_cuota: 1030, pesos: 206_000 }, series, "2030-07-17", () => {
      throw new Error("not called");
    });
    expect(r.check.status).toBe("waiting");
    expect(r.problems).toEqual([]);
  });

  it("flags website figures that do not add up", () => {
    const r = checkPensionStatedValue({ ...stated, pesos: 202_200 }, series, "2030-07-17", () => 202_100);
    expect(r.problems[0]).toContain("the website's own figures disagree");
  });
});
