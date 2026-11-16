import type { DisplayUnitCode } from "./core.js";
import type { Money } from "./flows.js";

/** One deposit event in the response's `unit` (at its own day's rate) and the running total. */
export interface DepositInflowEventInUnit {
  occurred_on: string;
  amt: number;
  cumulative: number;
}

/** The account detail bundle's deposit timelines — same merge as charts / summary deposits, in `unit`. */
export interface AccountDepositInflowsResponse {
  account_id: number;
  /** The currency every amount is in: the request's display unit. */
  unit: DisplayUnitCode;
  /** All external capital (includes state bonus). */
  total: number;
  /** Personal deposits only (excludes `state_bonus`). */
  display_total: number;
  events: DepositInflowEventInUnit[];
  display_events: DepositInflowEventInUnit[];
  /** APV-A state bonus rows (`state_bonus`). */
  state_contribution_total: number;
  state_contribution_events: DepositInflowEventInUnit[];
}

/**
 * One payment row of a loan's ledger (`GET /api/portfolio-groups/:slug/mortgage-ledger`, the account
 * detail bundle's `mortgageLedger`, the payment form's preview). A loan is stated in one currency
 * and paid in another (`loan_payments`: a UF mortgage paid in pesos), so every figure names its
 * ROLE, not a currency: a key ending `_loan` is in `loan_currency`, one ending `_pay` in
 * `payment_currency`.
 */
export interface DeptoMortgageSheetRow {
  cuota: string;
  occurred_on: string;
  /** The currency the lender states the balance and the minimum / maximum payment in. */
  loan_currency: string;
  /** The currency the payment and its parts are charged in. */
  payment_currency: string;
  pago_pay: number;
  pago_loan: number | null;
  pct_dividendo: string | null;
  /** `payment_currency` per unit of `loan_currency` on the row's day. */
  loan_rate_day: number | null;
  mm_pct: string | null;
  yy_pct: string | null;
  tasa_plus: number | null;
  credito_restante_loan: number | null;
  pct_credito_loan: string | null;
  restante_pay: number | null;
  pct_de_total: string | null;
  delta_credito_pay: number | null;
  valor_neto_loan: number | null;
  valor_neto_pay: number | null;
  pagado_neto_loan: number | null;
  delta_valor_neto_pay: number | null;
  valor_vivienda_loan: number | null;
  valor_vivienda_pay: number | null;
  min_loan: number | null;
  max_loan: number | null;
  incendio_pay: number | null;
  incendio_loan: number | null;
  desgravamen_pay: number | null;
  desgravamen_loan: number | null;
  total_seguros_loan: number | null;
  total_seguros_pay: number | null;
  seguros_interes_loan: number | null;
  seguros_interes_pay: number | null;
  amortizacion_pay: number | null;
  amortizacion_loan: number | null;
  amortizacion_ext_pay: number | null;
  amortizacion_ext_loan: number | null;
  amortizacion_total_loan: number | null;
  amortizacion_total_pay: number | null;
  interes_pay: number | null;
  interes_loan: number | null;
  /** A prepago's prepayment charge (the lender's comisión, a cost beside its accrued interest); null on a cuota. */
  prepayment_charge_pay: number | null;
  prepayment_charge_loan: number | null;
  delta_credito_amort_pay: number | null;
  interes_oculto_pay: number | null;
  interes_oculto_b_pay: number | null;
  interes_real_pay: number | null;
  interes_calculado_loan: number | null;
  amort_interes_text: string | null;
  pago_acumulado_pay: number | null;
  amort_acum_pay: number | null;
  interes_acum_pay: number | null;
}

/** The ledger's header figures; `_loan` / `_pay` keys as on {@link DeptoMortgageSheetRow}. */
export interface AccountMortgageLedgerMeta {
  loan_currency: string;
  payment_currency: string;
  valor_vivienda_loan: number | null;
  hipoteca_tras_pie_loan: number | null;
  pie_pay: number | null;
  pie_loan: number | null;
  row_count: number;
  /** Import provenance label (not a runtime file path). */
  csv_path: string;
}

export type DeptoPaymentScenarioTerm = 30 | 25 | 20 | 15 | 12 | 10 | 5 | "max";

/** One term's payment, in its row's `loan_currency` and `payment_currency`. */
export interface DeptoPaymentScenarioCell {
  term: DeptoPaymentScenarioTerm;
  payment_loan: number | null;
  payment_pay: number | null;
}

/** Reference only — min/max payment scenarios from the loan ledger (not movements). */
export interface DeptoPaymentScenarioRow {
  /** Schedule date (11th of month), not bank payment date. */
  occurred_on: string;
  cuota: string;
  loan_currency: string;
  payment_currency: string;
  min_payment_loan: number | null;
  min_payment_pay: number | null;
  scenarios: DeptoPaymentScenarioCell[];
  /** Projected upcoming installment (shown as first row). */
  is_next_payment?: boolean;
  /** The next row's minimum and maximum are the lender's quote (`mortgage_lender_quotes`), not a projection. */
  quoted?: boolean;
}

/** A card line that pays the mortgage cuota (mirror of server/src/mortgagePaymentCardMatch.ts). */
export interface MortgageCardLine {
  line_id: number;
  account_id: number;
  account_name: string;
  date: string;
  merchant: string;
  /** What the card was charged, in the loan's payment currency. */
  amount: Money;
}

export type MortgageCardMatchStatus = "matched" | "awaiting_card_line" | "ambiguous";

export interface MortgagePaymentCardMatch {
  cuota: string;
  paid_on: string;
  /** The cuota's payment as the ledger holds it. */
  pago: Money;
  status: MortgageCardMatchStatus;
  line: MortgageCardLine | null;
}

export interface AccountMortgageLedgerResponse {
  account_id: number;
  has_sheet_rows: boolean;
  meta: AccountMortgageLedgerMeta | null;
  rows: DeptoMortgageSheetRow[];
  payment_scenarios?: DeptoPaymentScenarioRow[];
  /** One entry per regular (numeric-label) cuota in `rows`, keyed by `cuota`. */
  card_matches: MortgagePaymentCardMatch[];
  /** Mortgage card charges no ledger cuota claimed. */
  card_lines_without_payment: MortgageCardLine[];
}

/** UF-timing reminder for the CC-paid mortgage cuota (global toast). See server/src/mortgageUfReminder.ts. */
export interface MortgageUfReminder {
  show: boolean;
  mode: "wait" | "pay_today" | null;
  reason: "no_cc_mortgage_line" | "already_paid" | "uf_unavailable" | "not_qualified" | null;
  cycle_month: string | null;
  window_start: string | null;
  window_end: string | null;
  cierre_iso: string | null;
  pay_after_iso: string | null;
  next_billing_month: string | null;
  uf_now: number | null;
  uf_best: number | null;
  best_pay_date: string | null;
  horizon_limited: boolean;
  card_last4: string | null;
}
