import { describe, expect, it } from "vitest";
import {
  balanceUfBeforePayment,
  computeMortgagePaymentAnalytics,
  formatSheetPercent,
  mortgageAnalyticsMetaFromLedger,
  mortgageMonthlyRateCompound,
} from "./mortgagePaymentAnalytics.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

const meta = {
  hipoteca_tras_pie_uf: 3950,
  pie_restante_clp: 146_632_532,
};

function cuota27Row(): DeptoMortgageSheetRow {
  return {
    cuota: "27",
    occurred_on: "2026-05-11",
    pago_clp: 3_212_395,
    pago_uf: 79.7641,
    uf_clp_day: 40_273.69,
    credito_restante_uf: 1835.4735,
    restante_clp: 73_921_291,
    amortizacion_clp: 110_000,
    amortizacion_uf: 2.73,
    amortizacion_ext_clp: 2_745_638,
    amortizacion_ext_uf: 68.17,
    interes_clp: 312_065,
    interes_uf: 7.7486,
    valor_neto_clp: 143_556_635,
    delta_credito_clp: -2_082_544,
    incendio_clp: 41_651,
    desgravamen_clp: 3041,
    total_seguros_clp: 44_692,
    min_uf: 11.5896,
    pagado_neto_uf: 2114.53,
    valor_neto_uf: 3564.53,
    valor_vivienda_uf: 5400,
    valor_vivienda_clp: 217_477_926,
    pago_acumulado_clp: 148_338_452,
    amort_acum_clp: 82_440_931,
    interes_acum_clp: 10_105_744,
    pct_dividendo: null,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    pct_credito_uf: null,
    pct_de_total: null,
    delta_credito_amort_clp: null,
    interes_oculto_clp: null,
    interes_oculto_b_clp: null,
    interes_real_clp: null,
    interes_calculado_uf: null,
    amort_interes_text: null,
    incendio_uf: null,
    desgravamen_uf: null,
    total_seguros_uf: null,
  };
}

function cuota26Row(): DeptoMortgageSheetRow {
  return {
    ...cuota27Row(),
    cuota: "26",
    occurred_on: "2026-04-11",
    uf_clp_day: 39_868.16,
    credito_restante_uf: 1906.3793,
    restante_clp: 76_003_835,
    pago_uf: 79.7669,
    amortizacion_ext_uf: 67.8,
    amortizacion_ext_clp: 2_703_241,
    interes_clp: 320_289,
    delta_credito_clp: -2_763_245,
  };
}

function cuota15Row(): DeptoMortgageSheetRow {
  return {
    ...cuota27Row(),
    cuota: "15",
    occurred_on: "2025-05-11",
    uf_clp_day: 39_138.96,
  };
}

describe("mortgageMonthlyRateCompound", () => {
  it("matches cuota 27 reference interest", () => {
    const bal = 1906.3793;
    const calc = Math.round(bal * mortgageMonthlyRateCompound() * 1e4) / 1e4;
    expect(calc).toBeCloseTo(7.6909, 4);
  });
});

describe("computeMortgagePaymentAnalytics", () => {
  it("fills cuota 27 analytics from CSV calibration", () => {
    const prior = cuota26Row();
    const row = cuota27Row();
    const ledger = [cuota15Row(), prior, row];
    const a = computeMortgagePaymentAnalytics(row, prior, ledger, meta);

    expect(a.pct_dividendo).toBe(formatSheetPercent(4.2));
    expect(a.mm_pct).toBe(formatSheetPercent(1.0));
    expect(a.yy_pct).toBe(formatSheetPercent(2.9));
    expect(a.tasa_plus).toBeCloseTo(7.85, 1);
    expect(a.pct_credito_uf).toBe(formatSheetPercent(46.5));
    expect(a.pct_de_total).toBe(formatSheetPercent(50.4));
    expect(a.interes_calculado_uf).toBeCloseTo(7.6909, 4);
    expect(a.delta_credito_amort_clp).toBe(2_082_544);
    expect(a.interes_oculto_clp).toBe(773_094);
    expect(a.interes_real_clp).toBe(1_085_159);
    expect(a.interes_oculto_b_clp).toBe(-773_094);
    const amortInt = Number(a.amort_interes_text?.replace(",", ".") ?? "0");
    expect(amortInt).toBeCloseTo(9.1508, 2);
  });

  it("balance before payment matches ledger roll-forward", () => {
    const row = cuota27Row();
    expect(balanceUfBeforePayment(row)).toBeCloseTo(1906.3735, 3);
  });
});

describe("mortgageAnalyticsMetaFromLedger", () => {
  it("reads pie row", () => {
    const pie: DeptoMortgageSheetRow = {
      ...cuota27Row(),
      cuota: "pie",
      credito_restante_uf: 3950,
      restante_clp: 146_632_532,
    };
    const m = mortgageAnalyticsMetaFromLedger([pie]);
    expect(m.hipoteca_tras_pie_uf).toBe(3950);
    expect(m.pie_restante_clp).toBe(146_632_532);
  });
});
