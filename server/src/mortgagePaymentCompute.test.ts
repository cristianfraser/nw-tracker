import { describe, expect, it } from "vitest";
import {
  computeMortgagePaymentRow,
  defaultDesgravamenClp,
  DESGRAVAMEN_CLP_PER_CLP_BALANCE,
} from "./mortgagePaymentCompute.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

function basePrior(overrides: Partial<DeptoMortgageSheetRow> = {}): DeptoMortgageSheetRow {
  return {
    cuota: "27",
    occurred_on: "2026-05-11",
    pago_clp: 3212395,
    pago_uf: 79.7641,
    pct_dividendo: null,
    uf_clp_day: 40273.69,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_uf: 1835.4735,
    pct_credito_uf: null,
    restante_clp: 73921291,
    pct_de_total: null,
    delta_credito_clp: null,
    valor_neto_uf: 3564.53,
    valor_neto_clp: 143556635,
    pagado_neto_uf: 2114.53,
    delta_valor_neto_clp: null,
    valor_vivienda_uf: 5400,
    valor_vivienda_clp: null,
    min_uf: null,
    incendio_clp: 41651,
    incendio_uf: null,
    desgravamen_clp: 3041,
    desgravamen_uf: null,
    total_seguros_uf: null,
    total_seguros_clp: null,
    amortizacion_clp: 110000,
    amortizacion_uf: 2.73,
    amortizacion_ext_clp: 2745638,
    amortizacion_ext_uf: 68.17,
    interes_clp: 312065,
    interes_uf: null,
    delta_credito_amort_clp: null,
    interes_oculto_clp: null,
    interes_oculto_b_clp: null,
    interes_real_clp: null,
    interes_calculado_uf: null,
    amort_interes_text: null,
    pago_acumulado_clp: 100,
    amort_acum_clp: 50,
    interes_acum_clp: 40,
    ...overrides,
  };
}

describe("mortgagePaymentCompute", () => {
  it("splits scheduled amortización from min UF and remainder as prepago", () => {
    const ledger = [basePrior()];
    const result = computeMortgagePaymentRow(ledger, {
      occurred_on: "2026-06-11",
      pago_clp: 1_795_575,
      interes_clp: 304_240,
      incendio_clp: 41_651,
      desgravamen_clp: 3041,
      cuota: "28",
    });
    expect(result.sheet.cuota).toBe("28");
    expect(result.sheet.amortizacion_clp).toBeGreaterThan(0);
    expect(result.sheet.amortizacion_clp).toBeLessThan(200_000);
    expect(result.sheet.amortizacion_ext_clp).toBeGreaterThan(1_000_000);
    expect(
      (result.sheet.amortizacion_clp ?? 0) + (result.sheet.amortizacion_ext_clp ?? 0)
    ).toBe(1_795_575 - 304_240 - 41_651 - 3041);
    expect(result.sheet.pct_dividendo).not.toBeNull();
    expect(result.sheet.interes_oculto_clp).not.toBeNull();
    expect(result.sheet.credito_restante_uf).toBeLessThan(1835.4735);
  });

  it("uses default desgravamen calibrated near historical cuota 27", () => {
    const priorUf = 1906.3793;
    const ufDay = 40273.69;
    const expected = defaultDesgravamenClp(priorUf, ufDay);
    expect(expected).toBe(Math.round(priorUf * ufDay * DESGRAVAMEN_CLP_PER_CLP_BALANCE));
    expect(Math.abs(expected - 3041)).toBeLessThanOrEqual(3);
  });

  it("throws when UF rate is missing", () => {
    const ledger = [basePrior({ occurred_on: "1900-01-01", credito_restante_uf: 1000 })];
    expect(() =>
      computeMortgagePaymentRow(ledger, {
        occurred_on: "1900-02-01",
        pago_clp: 100_000,
        interes_clp: 50_000,
        incendio_clp: 1000,
        cuota: "99",
      })
    ).toThrow(/UF rate/);
  });

  it("throws when payment is too small for scheduled cuota split", () => {
    const ledger = [basePrior()];
    expect(() =>
      computeMortgagePaymentRow(ledger, {
        occurred_on: "2026-06-11",
        pago_clp: 10_000,
        interes_clp: 50_000,
        incendio_clp: 1000,
        desgravamen_clp: 1000,
        cuota: "28",
      })
    ).toThrow(/Payment too small for scheduled cuota/);
  });
});
