import { describe, expect, it } from "vitest";
import {
  DEPTO_LOAN_CURRENCY,
  DEPTO_PAYMENT_CURRENCY,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import {
  mortgageCardLineDto,
  mortgageLedgerMetaDto,
  mortgageLedgerRowDto,
  mortgagePaymentCardMatchDto,
  paymentScenarioRowDto,
} from "./mortgageLedgerDto.js";
import { parseMortgagePaymentBody } from "./mortgagePaymentCreate.js";

/** A ledger row whose every figure is a different number, so a crossed mapping shows. */
function ledgerRow(): DeptoMortgageSheetRow {
  const textKeys = ["pct_dividendo", "mm_pct", "yy_pct", "pct_credito_uf", "pct_de_total", "amort_interes_text"];
  const numberKeys = [
    "pago_clp", "pago_uf", "uf_clp_day", "tasa_plus", "credito_restante_uf", "restante_clp", "delta_credito_clp",
    "valor_neto_uf", "valor_neto_clp", "pagado_neto_uf", "delta_valor_neto_clp", "valor_vivienda_uf",
    "valor_vivienda_clp", "min_uf", "max_uf", "incendio_clp", "incendio_uf", "desgravamen_clp", "desgravamen_uf",
    "total_seguros_uf", "total_seguros_clp", "seguros_interes_uf", "seguros_interes_clp", "amortizacion_clp",
    "amortizacion_uf", "amortizacion_ext_clp", "amortizacion_ext_uf", "amortizacion_total_uf",
    "amortizacion_total_clp", "interes_clp", "interes_uf", "prepayment_charge_clp", "prepayment_charge_uf",
    "delta_credito_amort_clp", "interes_oculto_clp", "interes_oculto_b_clp", "interes_real_clp",
    "interes_calculado_uf", "pago_acumulado_clp", "amort_acum_clp", "interes_acum_clp",
  ];
  const row: Record<string, unknown> = { cuota: "7", occurred_on: "2031-03-11" };
  textKeys.forEach((k, i) => (row[k] = `text-${i}`));
  numberKeys.forEach((k, i) => (row[k] = 1000 + i));
  return row as DeptoMortgageSheetRow;
}

/** The payload key of a ledger field: its role in place of the currency its name carries. */
function wireKey(ledgerKey: string): string {
  if (ledgerKey === "uf_clp_day") return "loan_rate_day";
  return ledgerKey.replace(/_uf$/, "_loan").replace(/_clp$/, "_pay");
}

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value == null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
}

const CURRENCY_NAMED = /(^|_)(clp|uf|usd|eur)(_|$)/;

describe("mortgage ledger payload", () => {
  it("states every ledger figure under its role key, beside the loan's two currencies", () => {
    const row = ledgerRow();
    const dto = mortgageLedgerRowDto(row) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(row)) expect([k, dto[wireKey(k)]]).toEqual([k, v]);
    expect(dto.loan_currency).toBe(DEPTO_LOAN_CURRENCY);
    expect(dto.payment_currency).toBe(DEPTO_PAYMENT_CURRENCY);
    expect(Object.keys(dto).length).toBe(Object.keys(row).length + 2);
    expect(Object.keys(dto).filter((k) => CURRENCY_NAMED.test(k))).toEqual([]);
  });

  it("states the meta, the scenarios and the card pairing without a currency in a key", () => {
    const meta = mortgageLedgerMetaDto({
      valor_vivienda_uf: 5000,
      hipoteca_tras_pie_uf: 4000,
      pie_clp: 30_000_000,
      pie_uf: 1000,
      row_count: 3,
      csv_path: "x",
    });
    expect(meta).toEqual({
      loan_currency: DEPTO_LOAN_CURRENCY,
      payment_currency: DEPTO_PAYMENT_CURRENCY,
      valor_vivienda_loan: 5000,
      hipoteca_tras_pie_loan: 4000,
      pie_pay: 30_000_000,
      pie_loan: 1000,
      row_count: 3,
      csv_path: "x",
    });
    const scenario = paymentScenarioRowDto({
      occurred_on: "2031-04-11",
      cuota: "8",
      min_payment_uf: 10.5,
      min_payment_clp: 420_000,
      scenarios: [{ term: 20, payment_uf: 14.25, payment_clp: 570_000 }],
      is_next_payment: true,
    });
    expect(scenario).toEqual({
      occurred_on: "2031-04-11",
      cuota: "8",
      loan_currency: DEPTO_LOAN_CURRENCY,
      payment_currency: DEPTO_PAYMENT_CURRENCY,
      min_payment_loan: 10.5,
      min_payment_pay: 420_000,
      scenarios: [{ term: 20, payment_loan: 14.25, payment_pay: 570_000 }],
      is_next_payment: true,
    });
    const line = { line_id: 1, account_id: 2, account_name: "Card", date: "2031-03-12", merchant: "LENDER", amount_clp: 420_000 };
    expect(mortgageCardLineDto(line).amount).toEqual({ value: 420_000, currency: DEPTO_PAYMENT_CURRENCY });
    const match = mortgagePaymentCardMatchDto({ cuota: "7", paid_on: "2031-03-11", pago_clp: 420_000, status: "matched", line });
    expect(match.pago).toEqual({ value: 420_000, currency: DEPTO_PAYMENT_CURRENCY });
    expect(match.line?.amount.value).toBe(420_000);
    expect(keysDeep([meta, scenario, match]).filter((k) => CURRENCY_NAMED.test(k))).toEqual([]);
  });
});

describe("parseMortgagePaymentBody", () => {
  it("reads the form's role-named figures", () => {
    expect(
      parseMortgagePaymentBody({
        occurred_on: " 2031-03-11 ",
        pago_pay: 420_000,
        interes_pay: 200_000,
        incendio_pay: 9_000,
        desgravamen_pay: 3_000,
        cuota: " 7 ",
        min_loan: 10.5,
        max_loan: 80.25,
        amortizacion_ext_pay: 0,
        credito_restante_loan: 1800.1234,
      })
    ).toEqual({
      occurred_on: "2031-03-11",
      pago_clp: 420_000,
      interes_clp: 200_000,
      incendio_clp: 9_000,
      desgravamen_clp: 3_000,
      cuota: "7",
      min_uf: 10.5,
      max_uf: 80.25,
      amortizacion_ext_clp: 0,
      credito_restante_uf: 1800.1234,
    });
  });

  it("refuses a body under the keys that named a currency, and a figure that is no number", () => {
    const old = { occurred_on: "2031-03-11", pago_clp: 420_000, interes_clp: 200_000, incendio_clp: 9_000 };
    expect(() => parseMortgagePaymentBody(old)).toThrow("pago_pay is required");
    const body = { occurred_on: "2031-03-11", pago_pay: 420_000, interes_pay: 200_000, incendio_pay: 9_000 };
    expect(() => parseMortgagePaymentBody({ ...body, min_loan: "x" })).toThrow("min_loan must be a number when provided");
    expect(parseMortgagePaymentBody(body)).toMatchObject({ desgravamen_clp: null, min_uf: null, credito_restante_uf: null });
  });
});
