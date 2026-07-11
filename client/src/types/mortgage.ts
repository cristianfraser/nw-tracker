/** `GET /api/accounts/:id/deposit-inflows` — same merge as charts / summary deposits */
export interface AccountDepositInflowsResponse {
  account_id: number;
  /** All external capital (includes state bonus). */
  total_clp: number;
  /** Personal deposits only (excludes `aporte_estatal_clp`). */
  display_total_clp: number;
  events: { occurred_on: string; amt_clp: number; cumulative_clp: number }[];
  display_events: { occurred_on: string; amt_clp: number; cumulative_clp: number }[];
  /** APV-A state bonus rows (`aporte_estatal_clp`). */
  state_contribution_total_clp: number;
  state_contribution_events: { occurred_on: string; amt_clp: number; cumulative_clp: number }[];
}

/** `GET /api/accounts/:id/mortgage-ledger` — property: full sheet from CSV; other accounts: empty. */
export interface DeptoMortgageSheetRow {
  cuota: string;
  occurred_on: string;
  pago_clp: number;
  pago_uf: number | null;
  pct_dividendo: string | null;
  uf_clp_day: number | null;
  mm_pct: string | null;
  yy_pct: string | null;
  tasa_plus: number | null;
  credito_restante_uf: number | null;
  pct_credito_uf: string | null;
  restante_clp: number | null;
  pct_de_total: string | null;
  delta_credito_clp: number | null;
  valor_neto_uf: number | null;
  valor_neto_clp: number | null;
  pagado_neto_uf: number | null;
  delta_valor_neto_clp: number | null;
  valor_vivienda_uf: number | null;
  valor_vivienda_clp: number | null;
  min_uf: number | null;
  incendio_clp: number | null;
  incendio_uf: number | null;
  desgravamen_clp: number | null;
  desgravamen_uf: number | null;
  total_seguros_uf: number | null;
  total_seguros_clp: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
  interes_clp: number | null;
  interes_uf: number | null;
  delta_credito_amort_clp: number | null;
  interes_oculto_clp: number | null;
  interes_oculto_b_clp: number | null;
  interes_real_clp: number | null;
  interes_calculado_uf: number | null;
  amort_interes_text: string | null;
  pago_acumulado_clp: number | null;
  amort_acum_clp: number | null;
  interes_acum_clp: number | null;
}

export interface AccountMortgageLedgerMeta {
  valor_vivienda_uf: number | null;
  hipoteca_tras_pie_uf: number | null;
  pie_clp: number | null;
  pie_uf: number | null;
  row_count: number;
  /** Import provenance label (not a runtime file path). */
  csv_path: string;
}

export type DeptoPaymentScenarioTerm = 30 | 25 | 20 | 15 | 12 | 10 | 5 | "max";

export interface DeptoPaymentScenarioCell {
  term: DeptoPaymentScenarioTerm;
  payment_uf: number | null;
  payment_clp: number | null;
}

/** Reference only — min/max UF payment scenarios from the depto sheet (not movements). */
export interface DeptoPaymentScenarioRow {
  /** Schedule date (11th of month), not bank payment date. */
  occurred_on: string;
  cuota: string;
  min_payment_uf: number | null;
  min_payment_clp: number | null;
  scenarios: DeptoPaymentScenarioCell[];
  /** Projected upcoming installment (shown as first row). */
  is_next_payment?: boolean;
}

export interface AccountMortgageLedgerResponse {
  account_id: number;
  has_sheet_rows: boolean;
  meta: AccountMortgageLedgerMeta | null;
  rows: DeptoMortgageSheetRow[];
  payment_scenarios?: DeptoPaymentScenarioRow[];
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
