import type { DisplayUnitCode } from "./core.js";

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

/** `GET /api/accounts/:id/mortgage-ledger` — property: full sheet from CSV; other accounts: empty. */
export interface DeptoMortgageSheetRow {
  cuota: string;
  occurred_on: string;
  pago_clp: number; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  pago_uf: number | null;
  pct_dividendo: string | null;
  uf_clp_day: number | null;
  mm_pct: string | null;
  yy_pct: string | null;
  tasa_plus: number | null;
  credito_restante_uf: number | null;
  pct_credito_uf: string | null;
  restante_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  pct_de_total: string | null;
  delta_credito_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  valor_neto_uf: number | null;
  valor_neto_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  pagado_neto_uf: number | null;
  delta_valor_neto_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  valor_vivienda_uf: number | null;
  valor_vivienda_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  min_uf: number | null;
  max_uf: number | null;
  incendio_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  incendio_uf: number | null;
  desgravamen_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  desgravamen_uf: number | null;
  total_seguros_uf: number | null;
  total_seguros_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  seguros_interes_uf: number | null;
  seguros_interes_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  amortizacion_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  amortizacion_ext_uf: number | null;
  amortizacion_total_uf: number | null;
  amortizacion_total_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_uf: number | null;
  /** A prepago's prepayment charge (the lender's comisión, a cost beside its accrued interest); null on a cuota. */
  prepayment_charge_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  prepayment_charge_uf: number | null;
  delta_credito_amort_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_oculto_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_oculto_b_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_real_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_calculado_uf: number | null;
  amort_interes_text: string | null;
  pago_acumulado_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  amort_acum_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  interes_acum_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
}

export interface AccountMortgageLedgerMeta {
  valor_vivienda_uf: number | null;
  hipoteca_tras_pie_uf: number | null;
  pie_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
  pie_uf: number | null;
  row_count: number;
  /** Import provenance label (not a runtime file path). */
  csv_path: string;
}

export type DeptoPaymentScenarioTerm = 30 | 25 | 20 | 15 | 12 | 10 | 5 | "max";

export interface DeptoPaymentScenarioCell {
  term: DeptoPaymentScenarioTerm;
  payment_uf: number | null;
  payment_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
}

/** Reference only — min/max UF payment scenarios from the depto sheet (not movements). */
export interface DeptoPaymentScenarioRow {
  /** Schedule date (11th of month), not bank payment date. */
  occurred_on: string;
  cuota: string;
  min_payment_uf: number | null;
  min_payment_clp: number | null; // convention-ok: a mortgage cuota as the lender bills it, in pesos
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
  amount_clp: number; // convention-ok: a mortgage cuota as the lender bills it, in pesos
}

export type MortgageCardMatchStatus = "matched" | "awaiting_card_line" | "ambiguous";

export interface MortgagePaymentCardMatch {
  cuota: string;
  paid_on: string;
  pago_clp: number; // convention-ok: a mortgage cuota as the lender bills it, in pesos
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
