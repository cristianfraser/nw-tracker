import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  appendDeptoDividendosSheetRowInDb,
  loadStoredDeptoSheetRowsFromDb,
  replaceDeptoDividendosSheetRowsInDb,
} from "./deptoSheetDb.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";

function minimalRow(cuota: string, occurredOn: string): DeptoMortgageSheetRow {
  return {
    cuota,
    occurred_on: occurredOn,
    pago_clp: 1000,
    pago_uf: null,
    pct_dividendo: null,
    uf_clp_day: null,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_uf: 100,
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
  };
}

describe("deptoSheetDb manual rows", () => {
  it("preserves manual rows when import replaces file rows", () => {
    const manualCuota = `vitest-manual-${Date.now()}`;
    const manualOn = "2098-06-15";
    appendDeptoDividendosSheetRowInDb({
      sheet: minimalRow(manualCuota, manualOn),
      origin: "manual",
    });

    replaceDeptoDividendosSheetRowsInDb([minimalRow("import-1", "2098-01-01")]);

    const stored = loadStoredDeptoSheetRowsFromDb();
    const manual = stored.find((r) => r.sheet.cuota === manualCuota);
    expect(manual?.origin).toBe("manual");

    db.prepare(`DELETE FROM depto_dividendos_sheet_rows WHERE cuota = ?`).run(manualCuota);
    db.prepare(`DELETE FROM depto_dividendos_sheet_rows WHERE cuota = ?`).run("import-1");
  });
});
