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
  overrides: Partial<DeptoMortgageSheetRow> & Pick<DeptoMortgageSheetRow, "occurred_on" | "pago_pay">
): DeptoMortgageSheetRow {
  return {
    cuota: "1",
    loan_currency: "uf",
    payment_currency: "clp",
    pago_loan: null,
    pct_dividendo: null,
    loan_rate_day: null,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_loan: null,
    pct_credito_loan: null,
    restante_pay: null,
    pct_de_total: null,
    delta_credito_pay: null,
    valor_neto_loan: null,
    valor_neto_pay: null,
    pagado_neto_loan: null,
    delta_valor_neto_pay: null,
    valor_vivienda_loan: null,
    valor_vivienda_pay: null,
    min_loan: null,
    max_loan: null,
    incendio_pay: null,
    incendio_loan: null,
    desgravamen_pay: null,
    desgravamen_loan: null,
    total_seguros_loan: null,
    total_seguros_pay: null,
    seguros_interes_loan: null,
    seguros_interes_pay: null,
    amortizacion_total_loan: null,
    amortizacion_total_pay: null,
    amortizacion_pay: null,
    amortizacion_loan: null,
    amortizacion_ext_pay: null,
    amortizacion_ext_loan: null,
    interes_pay: null,
    interes_loan: null,
    delta_credito_amort_pay: null,
    interes_oculto_pay: null,
    interes_oculto_b_pay: null,
    interes_real_pay: null,
    interes_calculado_loan: null,
    amort_interes_text: null,
    pago_acumulado_pay: null,
    amort_acum_pay: null,
    interes_acum_pay: null,
    prepayment_charge_pay: null,
    prepayment_charge_loan: null,
    ...overrides,
  };
}

describe("lastMortgagePaymentRow", () => {
  it("picks the latest row with pago_pay > 0", () => {
    const rows = [
      sheetRow({ occurred_on: "2025-01-11", pago_pay: 100_000 }),
      sheetRow({ occurred_on: "2025-03-11", pago_pay: 120_000 }),
      sheetRow({ occurred_on: "2025-02-11", pago_pay: 0 }),
    ];
    expect(lastMortgagePaymentRow(rows)?.occurred_on).toBe("2025-03-11");
    expect(lastMortgagePaymentRow(rows)?.pago_pay).toBe(120_000);
  });
});

describe("nextMortgagePaymentScenario", () => {
  it("returns the scenario flagged as next payment", () => {
    const scenarios: DeptoPaymentScenarioRow[] = [
      {
        occurred_on: "2025-02-11",
        cuota: "10",
        loan_currency: "uf",
        payment_currency: "clp",
        min_payment_loan: 10,
        min_payment_pay: 400_000,
        scenarios: [],
      },
      {
        occurred_on: "2025-03-11",
        cuota: "11",
        loan_currency: "uf",
        payment_currency: "clp",
        min_payment_loan: 9.5,
        min_payment_pay: 380_000,
        scenarios: [],
        is_next_payment: true,
      },
    ];
    expect(nextMortgagePaymentScenario(scenarios)?.occurred_on).toBe("2025-03-11");
    expect(nextMortgagePaymentScenario(scenarios)?.min_payment_pay).toBe(380_000);
  });
});

describe("latestLedgerSnapshotRow", () => {
  it("returns newest row with balance fields", () => {
    const rows = [
      sheetRow({
        occurred_on: "2025-01-11",
        pago_pay: 100_000,
        credito_restante_loan: 3000,
        restante_pay: 90_000_000,
      }),
      sheetRow({
        occurred_on: "2025-03-11",
        pago_pay: 120_000,
        credito_restante_loan: 2900,
        restante_pay: 85_000_000,
      }),
    ];
    expect(latestLedgerSnapshotRow(rows)?.credito_restante_loan).toBe(2900);
  });
});

describe("buildMortgageSummaryCardsData", () => {
  it("maps balance, last payment, and next payment", () => {
    const data = buildMortgageSummaryCardsData(
      {
        account_id: 1,
        has_sheet_rows: true,
        meta: null,
        card_matches: [],
        card_lines_without_payment: [],
        rows: [
          sheetRow({
            occurred_on: "2025-02-11",
            pago_pay: 500_000,
            credito_restante_loan: 2800,
            restante_pay: 74_695_292,
          }),
        ],
        payment_scenarios: [
          {
            occurred_on: "2025-03-11",
            cuota: "12",
            loan_currency: "uf",
            payment_currency: "clp",
            min_payment_loan: 8,
            min_payment_pay: 320_000,
            scenarios: [],
            is_next_payment: true,
          },
        ],
      },
      { latest_valuation: 74_695_292 },
      [],
      null
    );
    expect(data.balanceLoan).toEqual({ value: 2800, currency: "uf" });
    expect(data.balancePay).toEqual({ value: 74_695_292, currency: "clp" });
    expect(data.lastPayment).toEqual({ value: 500_000, currency: "clp" });
    expect(data.lastPaymentDate).toBe("2025-02-11");
    expect(data.nextPayment).toEqual({ value: 320_000, currency: "clp" });
    expect(data.nextPaymentDate).toBe("2025-03-11");
  });

  it("reads each figure in the currency its row names (a euro loan paid in dollars)", () => {
    const data = buildMortgageSummaryCardsData(
      {
        account_id: 1,
        has_sheet_rows: true,
        meta: null,
        card_matches: [],
        card_lines_without_payment: [],
        rows: [
          sheetRow({
            occurred_on: "2025-02-11",
            loan_currency: "eur",
            payment_currency: "usd",
            pago_pay: 650.25,
            credito_restante_loan: 91_000,
            restante_pay: 98_280.5,
          }),
        ],
        payment_scenarios: [
          {
            occurred_on: "2025-03-11",
            cuota: "12",
            loan_currency: "eur",
            payment_currency: "usd",
            min_payment_loan: 600,
            min_payment_pay: 648,
            scenarios: [],
            is_next_payment: true,
          },
        ],
      },
      // The fallbacks (home currency) are not reached: the ledger row carries the balance.
      { latest_valuation: 1 },
      [],
      null
    );
    expect(data.balanceLoan).toEqual({ value: 91_000, currency: "eur" });
    expect(data.balancePay).toEqual({ value: 98_280.5, currency: "usd" });
    expect(data.lastPayment).toEqual({ value: 650.25, currency: "usd" });
    expect(data.nextPayment).toEqual({ value: 648, currency: "usd" });
  });

  it("falls back to the home-currency valuation while the ledger has no balance row", () => {
    const data = buildMortgageSummaryCardsData(
      { account_id: 1, has_sheet_rows: false, meta: null, card_matches: [], card_lines_without_payment: [], rows: [] },
      { latest_valuation: 70_000_000 },
      [],
      null
    );
    expect(data.balanceLoan).toBeNull();
    expect(data.balancePay).toEqual({ value: 70_000_000, currency: "clp" });
    expect(data.lastPayment).toBeNull();
    expect(data.nextPayment).toBeNull();
  });
});

describe("buildPropertySummaryCardsData", () => {
  it("maps value, deposits, and PL from latest monthly perf", () => {
    const data = buildPropertySummaryCardsData(
      {
        account_id: 2,
        has_sheet_rows: true,
        meta: null,
        card_matches: [],
        card_lines_without_payment: [],
        rows: [
          sheetRow({
            occurred_on: "2025-02-11",
            pago_pay: 1,
            valor_neto_loan: 1200,
            valor_neto_pay: 45_000_000,
          }),
        ],
      },
      { unit: "clp", deposits: 94_511_320, latest_valuation: 45_000_000 },
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
    expect(data.valueLoan).toEqual({ value: 1200, currency: "uf" });
    expect(data.valuePay).toEqual({ value: 45_000_000, currency: "clp" });
    expect(data.deposited).toBe(94_511_320);
    expect(data.depositedUnit).toBe("clp");
    expect(data.plYtd).toBe(350_000);
    expect(data.plTotal).toBe(1_650_000);
    expect(data.plUnit).toBe("clp");
  });
});
