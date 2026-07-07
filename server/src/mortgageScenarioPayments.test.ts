import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";
import {
  buildDeptoPaymentScenarioRows,
  computeMortgageScenarioPaymentUf,
  firstMortgageScheduleYmd,
  mortgageScheduleYmdForCuota,
  mortgageScheduleYmdInMonth,
  nextMortgagePaymentScheduleYmd,
} from "./mortgageScenarioPayments.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

// Fixed uf_daily rows so payment_clp assertions don't drift with the daily UF sync.
const restoreTables = snapshotTables(["uf_daily"]);
afterAll(() => restoreTables());

const UF_ON_APR_11 = 38_000;
const UF_ON_MAY_11 = 38_100;

beforeAll(() => {
  db.prepare(`DELETE FROM uf_daily`).run();
  const ins = db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`);
  ins.run("2026-04-11", UF_ON_APR_11);
  ins.run("2026-05-11", UF_ON_MAY_11);
});

function sheetRow(overrides: Partial<DeptoMortgageSheetRow>): DeptoMortgageSheetRow {
  return {
    cuota: "1",
    occurred_on: "2026-04-20",
    pago_clp: 0,
    pago_uf: null,
    pct_dividendo: null,
    uf_clp_day: null,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_uf: null,
    pct_credito_uf: null,
    restante_clp: null,
    pct_de_total: null,
    delta_credito_clp: null,
    valor_neto_uf: null,
    valor_neto_clp: null,
    pagado_neto_uf: null,
    delta_valor_neto_clp: null,
    valor_vivienda_uf: null,
    valor_vivienda_clp: null,
    min_uf: null,
    incendio_clp: null,
    incendio_uf: null,
    desgravamen_clp: null,
    desgravamen_uf: null,
    total_seguros_uf: null,
    total_seguros_clp: null,
    amortizacion_clp: null,
    amortizacion_uf: null,
    amortizacion_ext_clp: null,
    amortizacion_ext_uf: null,
    interes_clp: null,
    interes_uf: null,
    delta_credito_amort_clp: null,
    interes_oculto_clp: null,
    interes_oculto_b_clp: null,
    interes_real_clp: null,
    interes_calculado_uf: null,
    amort_interes_text: null,
    pago_acumulado_clp: null,
    amort_acum_clp: null,
    interes_acum_clp: null,
    ...overrides,
  };
}

describe("mortgage schedule dates (day 11)", () => {
  it("maps any day in a month to that month's 11th", () => {
    expect(mortgageScheduleYmdInMonth("2024-05-23")).toBe("2024-05-11");
    expect(mortgageScheduleYmdInMonth("2024-05-01")).toBe("2024-05-11");
    expect(mortgageScheduleYmdInMonth("garbage")).toBeNull();
  });

  it("schedules cuota N by month offset from the first numeric cuota", () => {
    expect(mortgageScheduleYmdForCuota("2021-08-11", 2, 2)).toBe("2021-08-11");
    expect(mortgageScheduleYmdForCuota("2021-08-11", 2, 14)).toBe("2022-08-11");
    // December rollover crosses the year boundary.
    expect(mortgageScheduleYmdForCuota("2021-11-11", 1, 3)).toBe("2022-01-11");
    // Cuotas before the anchor have no schedule date.
    expect(mortgageScheduleYmdForCuota("2021-08-11", 2, 1)).toBeNull();
  });

  it("next payment is this month's 11th before the 11th, else next month's", () => {
    expect(nextMortgagePaymentScheduleYmd("2026-07-06")).toBe("2026-07-11");
    expect(nextMortgagePaymentScheduleYmd("2026-07-11")).toBe("2026-08-11");
    expect(nextMortgagePaymentScheduleYmd("2026-12-15")).toBe("2027-01-11");
    expect(nextMortgagePaymentScheduleYmd("nope")).toBeNull();
  });

  it("first schedule anchor skips the pie row", () => {
    const ledger = [
      { cuota: "pie", occurred_on: "2026-03-15" },
      { cuota: "1", occurred_on: "2026-04-20" },
      { cuota: "2", occurred_on: "2026-05-19" },
    ];
    expect(firstMortgageScheduleYmd(ledger)).toBe("2026-04-11");
    expect(firstMortgageScheduleYmd([{ cuota: "pie", occurred_on: "2026-03-15" }])).toBeNull();
  });
});

describe("computeMortgageScenarioPaymentUf (French amortization + seguros)", () => {
  // Constants hand-derived from bal·r/(1−(1+r)^−(plazo−num+3)) + seguros at 4,95% annual.
  it("matches the sheet formula for known inputs", () => {
    expect(computeMortgageScenarioPaymentUf(1000, 360, 1, 0.5)).toBe(5.82486);
    expect(computeMortgageScenarioPaymentUf(500, 60, 12, 0)).toBe(10.89144);
  });

  it("shorter plazo means a higher payment for the same balance", () => {
    const p30 = computeMortgageScenarioPaymentUf(2000, 360, 24, 1.2)!;
    const p5 = computeMortgageScenarioPaymentUf(2000, 60, 24, 1.2)!;
    expect(p30).toBe(12.16651);
    expect(p5).toBe(56.82307);
    expect(p5).toBeGreaterThan(p30);
  });

  it("returns null for exhausted balances or plazos shorter than the payment number", () => {
    expect(computeMortgageScenarioPaymentUf(0, 360, 1, 0.5)).toBeNull();
    expect(computeMortgageScenarioPaymentUf(-10, 360, 1, 0.5)).toBeNull();
    expect(computeMortgageScenarioPaymentUf(1000, 60, 100, 0)).toBeNull();
  });
});

describe("buildDeptoPaymentScenarioRows", () => {
  const ledger: DeptoMortgageSheetRow[] = [
    sheetRow({ cuota: "pie", occurred_on: "2026-03-15" }),
    sheetRow({
      cuota: "1",
      occurred_on: "2026-04-20",
      credito_restante_uf: 1000,
      amortizacion_uf: 2,
      total_seguros_uf: 0.5,
    }),
    sheetRow({
      cuota: "2",
      occurred_on: "2026-05-19",
      credito_restante_uf: 998,
      amortizacion_uf: 2,
      total_seguros_uf: 0.5,
    }),
  ];

  it("returns [] without numeric cuotas", () => {
    expect(buildDeptoPaymentScenarioRows([])).toEqual([]);
    expect(
      buildDeptoPaymentScenarioRows([sheetRow({ cuota: "pie", occurred_on: "2026-03-15" })])
    ).toEqual([]);
  });

  it("emits historical rows on the day-11 schedule plus a projected next row", () => {
    const rows = buildDeptoPaymentScenarioRows(ledger);
    expect(rows).toHaveLength(3);

    const [r1, r2, next] = rows as [
      (typeof rows)[number],
      (typeof rows)[number],
      (typeof rows)[number],
    ];
    expect(r1.cuota).toBe("1");
    expect(r1.occurred_on).toBe("2026-04-11");
    expect(r1.is_next_payment).toBeUndefined();
    expect(r2.cuota).toBe("2");
    expect(r2.occurred_on).toBe("2026-05-11");

    expect(next.cuota).toBe("3");
    expect(next.is_next_payment).toBe(true);
    expect(next.occurred_on).toBe(nextMortgagePaymentScheduleYmd());
  });

  it("computes payments from balance-before-payment; min = 30-year column", () => {
    const rows = buildDeptoPaymentScenarioRows(ledger);
    const r1 = rows[0]!;
    // Balance before cuota 1 = restante after (1000) + amortización (2).
    const expectedMinUf = computeMortgageScenarioPaymentUf(1002, 360, 1, 0.5);
    expect(r1.min_payment_uf).toBe(expectedMinUf);
    expect(r1.min_payment_clp).toBe(Math.round(expectedMinUf! * UF_ON_APR_11));
    // Scenario cells exclude the 30-year term (that is the min column).
    expect(r1.scenarios.map((s) => s.term)).toEqual([25, 20, 15, 12, 10, 5, "max"]);
    // `max` shares the 5-year plazo.
    const t5 = r1.scenarios.find((s) => s.term === 5)!;
    const tMax = r1.scenarios.find((s) => s.term === "max")!;
    expect(tMax.payment_uf).toBe(t5.payment_uf);
    expect(t5.payment_uf).toBe(computeMortgageScenarioPaymentUf(1002, 60, 1, 0.5));
  });

  it("projects the next payment from balance-after-last-payment at the latest UF", () => {
    const rows = buildDeptoPaymentScenarioRows(ledger);
    const next = rows[2]!;
    // Next row uses credito_restante_uf as-is (no amortización add-back), payment number 3.
    const expectedUf = computeMortgageScenarioPaymentUf(998, 360, 3, 0.5);
    expect(next.min_payment_uf).toBe(expectedUf);
    // Latest uf_daily row on-or-before the projected date is 2026-05-11.
    expect(next.min_payment_clp).toBe(Math.round(expectedUf! * UF_ON_MAY_11));
  });
});
