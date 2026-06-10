import { describe, expect, it } from "vitest";
import {
  buildMortgageSummaryCardsData,
  buildPropertySummaryCardsData,
  lastMortgagePaymentRow,
  latestLedgerSnapshotRow,
  nextMortgagePaymentScenario,
} from "./deptoAccountSummary";
import type { DeptoMortgageSheetRow, DeptoPaymentScenarioRow } from "../../types";

function sheetRow(
  overrides: Partial<DeptoMortgageSheetRow> & Pick<DeptoMortgageSheetRow, "occurred_on" | "pago_clp">
): DeptoMortgageSheetRow {
  return {
    cuota: "1",
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

describe("lastMortgagePaymentRow", () => {
  it("picks the latest row with pago_clp > 0", () => {
    const rows = [
      sheetRow({ occurred_on: "2025-01-11", pago_clp: 100_000 }),
      sheetRow({ occurred_on: "2025-03-11", pago_clp: 120_000 }),
      sheetRow({ occurred_on: "2025-02-11", pago_clp: 0 }),
    ];
    expect(lastMortgagePaymentRow(rows)?.occurred_on).toBe("2025-03-11");
    expect(lastMortgagePaymentRow(rows)?.pago_clp).toBe(120_000);
  });
});

describe("nextMortgagePaymentScenario", () => {
  it("returns the scenario flagged as next payment", () => {
    const scenarios: DeptoPaymentScenarioRow[] = [
      {
        occurred_on: "2025-02-11",
        cuota: "10",
        min_payment_uf: 10,
        min_payment_clp: 400_000,
        scenarios: [],
      },
      {
        occurred_on: "2025-03-11",
        cuota: "11",
        min_payment_uf: 9.5,
        min_payment_clp: 380_000,
        scenarios: [],
        is_next_payment: true,
      },
    ];
    expect(nextMortgagePaymentScenario(scenarios)?.occurred_on).toBe("2025-03-11");
    expect(nextMortgagePaymentScenario(scenarios)?.min_payment_clp).toBe(380_000);
  });
});

describe("latestLedgerSnapshotRow", () => {
  it("returns newest row with balance fields", () => {
    const rows = [
      sheetRow({
        occurred_on: "2025-01-11",
        pago_clp: 100_000,
        credito_restante_uf: 3000,
        restante_clp: 90_000_000,
      }),
      sheetRow({
        occurred_on: "2025-03-11",
        pago_clp: 120_000,
        credito_restante_uf: 2900,
        restante_clp: 85_000_000,
      }),
    ];
    expect(latestLedgerSnapshotRow(rows)?.credito_restante_uf).toBe(2900);
  });
});

describe("buildMortgageSummaryCardsData", () => {
  it("maps balance, last payment, and next payment", () => {
    const data = buildMortgageSummaryCardsData(
      {
        account_id: 1,
        has_sheet_rows: true,
        meta: null,
        rows: [
          sheetRow({
            occurred_on: "2025-02-11",
            pago_clp: 500_000,
            credito_restante_uf: 2800,
            restante_clp: 74_695_292,
          }),
        ],
        payment_scenarios: [
          {
            occurred_on: "2025-03-11",
            cuota: "12",
            min_payment_uf: 8,
            min_payment_clp: 320_000,
            scenarios: [],
            is_next_payment: true,
          },
        ],
      },
      { latest_valuation_clp: 74_695_292 },
      [],
      null
    );
    expect(data.balanceUf).toBe(2800);
    expect(data.balanceClp).toBe(74_695_292);
    expect(data.lastPaymentClp).toBe(500_000);
    expect(data.lastPaymentDate).toBe("2025-02-11");
    expect(data.nextPaymentClp).toBe(320_000);
    expect(data.nextPaymentDate).toBe("2025-03-11");
  });
});

describe("buildPropertySummaryCardsData", () => {
  it("maps value, deposits, and PL from latest monthly perf", () => {
    const data = buildPropertySummaryCardsData(
      {
        account_id: 2,
        has_sheet_rows: true,
        meta: null,
        rows: [
          sheetRow({
            occurred_on: "2025-02-11",
            pago_clp: 1,
            valor_neto_uf: 1200,
            valor_neto_clp: 45_000_000,
          }),
        ],
      },
      { deposits_clp: 94_511_320, latest_valuation_clp: 45_000_000 },
      [
        {
          as_of_date: "2025-01-31",
          closing_value: 40_000_000,
          prior_closing: null,
          net_capital_flow: 0,
          stock_units_inflow: 0,
          nominal_pl: 100_000,
          pct_month: null,
          ytd_nominal_pl: 200_000,
          cumulative_nominal_pl: 1_500_000,
          unit: "clp",
        },
        {
          as_of_date: "2025-02-28",
          closing_value: 45_000_000,
          prior_closing: 40_000_000,
          net_capital_flow: 0,
          stock_units_inflow: 0,
          nominal_pl: 150_000,
          pct_month: null,
          ytd_nominal_pl: 350_000,
          cumulative_nominal_pl: 1_650_000,
          unit: "clp",
        },
      ],
      null
    );
    expect(data.valueUf).toBe(1200);
    expect(data.valueClp).toBe(45_000_000);
    expect(data.depositedClp).toBe(94_511_320);
    expect(data.plYtdClp).toBe(350_000);
    expect(data.plTotalClp).toBe(1_650_000);
  });
});
