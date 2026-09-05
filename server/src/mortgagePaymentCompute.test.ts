import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  computeMortgagePaymentRow,
  defaultDesgravamenClp,
  DESGRAVAMEN_CLP_PER_CLP_BALANCE,
} from "./mortgagePaymentCompute.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

// Controlled UF rate on a far-future date so the split math is deterministic regardless of
// what uf_daily holds in the synthetic test DB. on-or-before this date returns exactly this
// row (nothing later exists), reproducing the real Depto rate on the day of the bug report.
const TEST_UF_YMD = "2099-01-11";
const TEST_UF_CLP = 40844.79;

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
  beforeAll(() => {
    db.prepare(`INSERT OR REPLACE INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run(
      TEST_UF_YMD,
      TEST_UF_CLP
    );
  });
  afterAll(() => {
    db.prepare(`DELETE FROM uf_daily WHERE date = ?`).run(TEST_UF_YMD);
  });

  it("splits amortización exactly from the bank minimum installment (regression)", () => {
    // The exact bug report: a modeled min payment (scenario formula) misallocated ~413 CLP
    // between amortización and prepago. With the real cuota mínima as input, the split is exact.
    const prior = basePrior({
      cuota: "28",
      occurred_on: "2026-06-11",
      credito_restante_uf: 1800.0,
      valor_vivienda_uf: 5400,
      uf_clp_day: TEST_UF_CLP,
    });
    const result = computeMortgagePaymentRow([prior], {
      occurred_on: TEST_UF_YMD,
      pago_clp: 750_200,
      interes_clp: 298_968,
      incendio_clp: 42_242,
      desgravamen_clp: 2912,
      min_uf: 11.0333,
      cuota: "29",
    });
    expect(result.sheet.cuota).toBe("29");
    expect(result.sheet.amortizacion_clp).toBe(106_531);
    expect(result.sheet.amortizacion_ext_clp).toBe(299_547);
    expect(result.sheet.min_uf).toBe(11.0333);
    expect(result.sheet.credito_restante_uf).toBe(1790.058);
    // Components still reconcile to pago exactly.
    expect(
      298_968 + 42_242 + 2912 + (result.sheet.amortizacion_clp ?? 0) + (result.sheet.amortizacion_ext_clp ?? 0)
    ).toBe(750_200);
  });

  it("throws when neither min_uf nor amortización extra is supplied", () => {
    const prior = basePrior({
      cuota: "28",
      occurred_on: "2026-06-11",
      credito_restante_uf: 1800.0,
      uf_clp_day: TEST_UF_CLP,
    });
    expect(() =>
      computeMortgagePaymentRow([prior], {
        occurred_on: TEST_UF_YMD,
        pago_clp: 750_200,
        interes_clp: 298_968,
        incendio_clp: 42_242,
        desgravamen_clp: 2912,
        cuota: "29",
      })
    ).toThrow(/cuota mínima/);
  });

  it("uses explicit amortización extra when given (min_uf display-only)", () => {
    const prior = basePrior({
      cuota: "28",
      occurred_on: "2026-06-11",
      credito_restante_uf: 1800.0,
      valor_vivienda_uf: 5400,
      uf_clp_day: TEST_UF_CLP,
    });
    const result = computeMortgagePaymentRow([prior], {
      occurred_on: TEST_UF_YMD,
      pago_clp: 750_200,
      interes_clp: 298_968,
      incendio_clp: 42_242,
      desgravamen_clp: 2912,
      amortizacion_ext_clp: 299_547,
      min_uf: 11.0333,
      cuota: "29",
    });
    // Explicit prepago drives the split; amortización is the remainder.
    expect(result.sheet.amortizacion_ext_clp).toBe(299_547);
    expect(result.sheet.amortizacion_clp).toBe(750_200 - 298_968 - 42_242 - 2912 - 299_547);
    expect(result.sheet.min_uf).toBe(11.0333);
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

  it("bank-stated crédito restante overrides the derived balance within tolerance", () => {
    // The 2026-08-11 cuota 30 case: the bank amortizes in UF at higher precision than the
    // CLP components can express, so its printed balance sits 0,0001 UF above the derived
    // one. The stated figure wins; downstream fields (restante_clp, valor neto) use it.
    const prior = basePrior({
      cuota: "29",
      occurred_on: "2026-07-11",
      credito_restante_uf: 1790.058,
      valor_vivienda_uf: 5400,
      uf_clp_day: TEST_UF_CLP,
    });
    const input = {
      occurred_on: TEST_UF_YMD,
      pago_clp: 753_333,
      interes_clp: 297_349,
      incendio_clp: 42_244,
      desgravamen_clp: 2896,
      min_uf: 10.9928,
      cuota: "30",
    };
    const derived = computeMortgagePaymentRow([prior], input);
    expect(derived.credito_restante_used_override).toBe(false);
    expect(derived.sheet.credito_restante_uf).toBe(derived.credito_restante_derived_uf);

    const stated = derived.credito_restante_derived_uf + 0.0001;
    const result = computeMortgagePaymentRow([prior], {
      ...input,
      credito_restante_uf: stated,
    });
    expect(result.credito_restante_used_override).toBe(true);
    expect(result.credito_restante_derived_uf).toBe(derived.credito_restante_derived_uf);
    expect(result.sheet.credito_restante_uf).toBeCloseTo(stated, 8);
    expect(result.sheet.restante_clp).toBe(Math.round(stated * TEST_UF_CLP));
    expect(result.sheet.valor_neto_uf).toBeCloseTo(5400 - stated, 4);
    // The split itself is untouched — only the balance re-syncs to the statement.
    expect(result.sheet.amortizacion_clp).toBe(derived.sheet.amortizacion_clp);
    expect(result.sheet.amortizacion_ext_clp).toBe(derived.sheet.amortizacion_ext_clp);
  });

  it("throws when the stated crédito restante is too far from the derived balance", () => {
    const prior = basePrior({
      cuota: "29",
      occurred_on: "2026-07-11",
      credito_restante_uf: 1790.058,
      valor_vivienda_uf: 5400,
      uf_clp_day: TEST_UF_CLP,
    });
    expect(() =>
      computeMortgagePaymentRow([prior], {
        occurred_on: TEST_UF_YMD,
        pago_clp: 753_333,
        interes_clp: 297_349,
        incendio_clp: 42_244,
        desgravamen_clp: 2896,
        min_uf: 10.9928,
        cuota: "30",
        credito_restante_uf: 1781.01,
      })
    ).toThrow(/away from the derived/);
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
        min_uf: 11.0,
        cuota: "28",
      })
    ).toThrow(/Payment too small for scheduled cuota/);
  });
});
