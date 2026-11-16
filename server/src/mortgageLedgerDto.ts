/**
 * The loan ledger as the API states it. The depto ledger's in-memory rows name their one pair of
 * currencies in their fields (`_uf` / `_clp`: a UF loan paid in pesos, `deptoDividendosLedger.ts`);
 * a payload names each figure's ROLE instead — `_loan` (in `loan_currency`: what the lender states
 * the balance and the minimum / maximum in) and `_pay` (in `payment_currency`: what the payment and
 * its parts are charged in) — and carries the two currencies beside them, as `loan_payments` does.
 * Every ledger payload leaves the server through these mappers.
 */
import type {
  AccountMortgageLedgerMeta,
  AccountMortgageLedgerResponse,
  DeptoMortgageSheetRow as MortgageLedgerRowDto,
  DeptoPaymentScenarioRow as PaymentScenarioRowDto,
  MortgageCardLine as MortgageCardLineDto,
  MortgagePaymentCardMatch as MortgagePaymentCardMatchDto,
} from "nw-tracker-contracts/dto";
import {
  DEPTO_LOAN_CURRENCY,
  DEPTO_PAYMENT_CURRENCY,
  mortgageMetaFromSheetRows,
  type DeptoMortgageCsvMeta,
  type DeptoMortgageSheetRow,
  type DeptoPaymentScenarioRow,
} from "./deptoDividendosLedger.js";
import { nextCuotaQuoteForLoan } from "./mortgageLenderQuotes.js";
import {
  mortgageCardMatches,
  type MortgageCardLine,
  type MortgagePaymentCardMatch,
} from "./mortgagePaymentCardMatch.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";

export type {
  AccountMortgageLedgerMeta,
  AccountMortgageLedgerResponse,
  MortgageCardLineDto,
  MortgageLedgerRowDto,
  MortgagePaymentCardMatchDto,
  PaymentScenarioRowDto,
};

export function mortgageLedgerRowDto(r: DeptoMortgageSheetRow): MortgageLedgerRowDto {
  return {
    cuota: r.cuota,
    occurred_on: r.occurred_on,
    loan_currency: DEPTO_LOAN_CURRENCY,
    payment_currency: DEPTO_PAYMENT_CURRENCY,
    pago_pay: r.pago_clp,
    pago_loan: r.pago_uf,
    pct_dividendo: r.pct_dividendo,
    loan_rate_day: r.uf_clp_day,
    mm_pct: r.mm_pct,
    yy_pct: r.yy_pct,
    tasa_plus: r.tasa_plus,
    credito_restante_loan: r.credito_restante_uf,
    pct_credito_loan: r.pct_credito_uf,
    restante_pay: r.restante_clp,
    pct_de_total: r.pct_de_total,
    delta_credito_pay: r.delta_credito_clp,
    valor_neto_loan: r.valor_neto_uf,
    valor_neto_pay: r.valor_neto_clp,
    pagado_neto_loan: r.pagado_neto_uf,
    delta_valor_neto_pay: r.delta_valor_neto_clp,
    valor_vivienda_loan: r.valor_vivienda_uf,
    valor_vivienda_pay: r.valor_vivienda_clp,
    min_loan: r.min_uf,
    max_loan: r.max_uf,
    incendio_pay: r.incendio_clp,
    incendio_loan: r.incendio_uf,
    desgravamen_pay: r.desgravamen_clp,
    desgravamen_loan: r.desgravamen_uf,
    total_seguros_loan: r.total_seguros_uf,
    total_seguros_pay: r.total_seguros_clp,
    seguros_interes_loan: r.seguros_interes_uf,
    seguros_interes_pay: r.seguros_interes_clp,
    amortizacion_pay: r.amortizacion_clp,
    amortizacion_loan: r.amortizacion_uf,
    amortizacion_ext_pay: r.amortizacion_ext_clp,
    amortizacion_ext_loan: r.amortizacion_ext_uf,
    amortizacion_total_loan: r.amortizacion_total_uf,
    amortizacion_total_pay: r.amortizacion_total_clp,
    interes_pay: r.interes_clp,
    interes_loan: r.interes_uf,
    prepayment_charge_pay: r.prepayment_charge_clp,
    prepayment_charge_loan: r.prepayment_charge_uf,
    delta_credito_amort_pay: r.delta_credito_amort_clp,
    interes_oculto_pay: r.interes_oculto_clp,
    interes_oculto_b_pay: r.interes_oculto_b_clp,
    interes_real_pay: r.interes_real_clp,
    interes_calculado_loan: r.interes_calculado_uf,
    amort_interes_text: r.amort_interes_text,
    pago_acumulado_pay: r.pago_acumulado_clp,
    amort_acum_pay: r.amort_acum_clp,
    interes_acum_pay: r.interes_acum_clp,
  };
}

export function mortgageLedgerMetaDto(m: DeptoMortgageCsvMeta): AccountMortgageLedgerMeta {
  return {
    loan_currency: DEPTO_LOAN_CURRENCY,
    payment_currency: DEPTO_PAYMENT_CURRENCY,
    valor_vivienda_loan: m.valor_vivienda_uf,
    hipoteca_tras_pie_loan: m.hipoteca_tras_pie_uf,
    pie_pay: m.pie_clp,
    pie_loan: m.pie_uf,
    row_count: m.row_count,
    csv_path: m.csv_path,
  };
}

export function paymentScenarioRowDto(r: DeptoPaymentScenarioRow): PaymentScenarioRowDto {
  return {
    occurred_on: r.occurred_on,
    cuota: r.cuota,
    loan_currency: DEPTO_LOAN_CURRENCY,
    payment_currency: DEPTO_PAYMENT_CURRENCY,
    min_payment_loan: r.min_payment_uf,
    min_payment_pay: r.min_payment_clp,
    scenarios: r.scenarios.map((c) => ({ term: c.term, payment_loan: c.payment_uf, payment_pay: c.payment_clp })),
    ...(r.is_next_payment !== undefined ? { is_next_payment: r.is_next_payment } : {}),
    ...(r.quoted !== undefined ? { quoted: r.quoted } : {}),
  };
}

export function mortgageCardLineDto(l: MortgageCardLine): MortgageCardLineDto {
  return {
    line_id: l.line_id,
    account_id: l.account_id,
    account_name: l.account_name,
    date: l.date,
    merchant: l.merchant,
    amount: { value: l.amount_clp, currency: DEPTO_PAYMENT_CURRENCY },
  };
}

export function mortgagePaymentCardMatchDto(m: MortgagePaymentCardMatch): MortgagePaymentCardMatchDto {
  return {
    cuota: m.cuota,
    paid_on: m.paid_on,
    pago: { value: m.pago_clp, currency: DEPTO_PAYMENT_CURRENCY },
    status: m.status,
    line: m.line ? mortgageCardLineDto(m.line) : null,
  };
}

/** The ledger payload of an account that reads no loan ledger. */
export function emptyMortgageLedgerDto(accountId: number): AccountMortgageLedgerResponse {
  return {
    account_id: accountId,
    has_sheet_rows: false,
    meta: null,
    rows: [],
    card_matches: [],
    card_lines_without_payment: [],
  };
}

/**
 * One account's ledger payload: `ledger` is its property's whole ledger (the meta and the
 * scenarios read all of it), `rows` the rows the account lists (a loan leaves the pie out), and
 * `loanAccountId` the loan whose lender quote and card pairing it shows (null: a property with no loan).
 */
export function mortgageLedgerDto(args: {
  accountId: number;
  ledger: DeptoMortgageSheetRow[];
  rows: readonly DeptoMortgageSheetRow[];
  loanAccountId: number | null;
}): AccountMortgageLedgerResponse {
  const { accountId, ledger, rows, loanAccountId } = args;
  const matches = loanAccountId != null ? mortgageCardMatches(loanAccountId) : { payments: [], unmatched_lines: [] };
  return {
    account_id: accountId,
    has_sheet_rows: ledger.length > 0,
    meta: ledger.length > 0 ? mortgageLedgerMetaDto(mortgageMetaFromSheetRows(ledger)) : null,
    rows: rows.map(mortgageLedgerRowDto),
    payment_scenarios: buildDeptoPaymentScenarioRows(
      ledger,
      loanAccountId != null ? nextCuotaQuoteForLoan(loanAccountId, ledger) : null
    ).map(paymentScenarioRowDto),
    card_matches: matches.payments.map(mortgagePaymentCardMatchDto),
    card_lines_without_payment: matches.unmatched_lines.map(mortgageCardLineDto),
  };
}
