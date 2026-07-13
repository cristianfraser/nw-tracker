import type { AccountMortgageLedgerResponse } from "./mortgage";

import type { DataOrigin } from "../dataOrigin";

/** `GET /api/accounts/:id/cc-installments` — credit_card: installment purchases from SQLite (PDF/ledger import). */
export interface CcStatementLineDto {
  id: number;
  statement_id: number;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  description_merged: string | null;
  country: string | null;
  amount_orig: number | null;
  orig_currency: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  installment_flag: boolean;
}

export interface CcStatementDto {
  id: number;
  account_id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  statement_date_iso: string;
  period_from: string | null;
  period_to: string | null;
  pay_by: string | null;
  pay_by_iso: string | null;
  billing_month: string | null;
  layout: string;
  currency: string;
  monto_facturado: number | null;
  deuda_total: number | null;
  lines: CcStatementLineDto[];
}

export interface CcBillingMonthBalanceDto {
  id: number;
  billing_month: string;
  as_of_date: string;
  as_of_kind: string;
  facturado_clp: number | null;
  facturado_usd: number | null;
  cupo_utilizado_clp: number;
  saldo_total_clp: number;
  saldo_total_usd: number | null;
}

export interface CcBillingDetailMonthDto {
  billing_month: string;
  as_of_date: string;
  as_of_kind: "statement" | "manual";
  total_facturado_actual_clp: number | null;
  total_facturado_clp: number | null;
  cupo_en_cuotas_clp: number;
  cuota_a_pagar_next_mes_clp: number;
  balance_total_clp: number;
  /** Plan-only future month (no statement or balance evidence yet). */
  projected?: boolean;
}

export interface CcFacturacionDto {
  billing_month: string;
  close_date: string;
  close_date_iso: string;
  pay_by: string | null;
  pay_by_iso: string | null;
  facturado_clp: number | null;
  facturado_usd: number | null;
  facturado_usd_clp: number | null;
  facturado_total_clp: number | null;
  cuota_a_pagar_clp: number | null;
  /** True before PDF close — facturado includes únicos + cuota a pagar. */
  is_open_month: boolean;
}

export interface CcFinancingPlMonthDto {
  billing_month: string;
  statement_charges_clp: number;
  installment_interest_clp: number;
  financing_cost_clp: number;
  ytd_financing_cost_clp: number;
  cumulative_financing_cost_clp: number;
}

export interface CreditCardBillingConfigDto {
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
}

export interface CcInstallmentPurchaseComputed {
  purchase_id: string;
  purchase_db_id?: number;
  origin: DataOrigin;
  /** @deprecated Use `origin`. */
  purchase_source?: "pdf" | "manual";
  label: string;
  principal_clp: number;
  installment_count: number;
  installments_paid: number;
  cuota_clp: number;
  annual_interest_pct: number;
  first_due_month: string;
  schedule_offset_months: number;
  purchase_month: string | null;
  /** Purchase date (YYYY-MM-DD; DB ledger only). */
  purchase_date?: string;
  /** Facturación month the purchase falls into (billing config applied to the purchase date). */
  purchase_billing_month?: string | null;
  note: string | null;
  remaining_installments: number;
  remaining_principal_clp: number;
  next_due_month: string | null;
  next_installment_index: number | null;
  /** YYYY-MM from last payment row (DB) or schedule (CSV). */
  last_paid_month: string | null;
  upcoming_cuota_clp: number;
  payment_statements?: {
    pay_by_date: string;
    statement_date: string | null;
    source_pdf: string | null;
    cuota_current: number | null;
    amount_clp: number;
  }[];
  merged_purchase_ids?: number[];
  merge_reason?: string | null;
  heuristic_hints?: string[];
}

export interface CcInstallmentMonthBreakdown {
  purchase_id: string;
  label: string;
  installment_index: number;
  installment_count: number;
  amount_clp: number;
}

export interface CcInstallmentMonthRow {
  /** Facturación (statement) month — the close that bills these cuotas. */
  month: string;
  total_clp: number;
  breakdown: CcInstallmentMonthBreakdown[];
  /** Statement PAGAR HASTA when closed; derived (~10th of next month) for open/projected. */
  pay_by_date: string;
  /** Plan debt remaining after this facturación's cuotas are paid (last row = 0). */
  debt_after_clp: number;
}

export interface AccountCcInstallmentsMeta {
  installment_purchase_count?: number;
  installment_payment_count?: number;
  pay_by_rule?: string;
  remaining_balance_line_rule?: string;
}

export interface CcInstallmentHistoryMonthPoint {
  month: string;
  remaining_balance_clp: number;
  installment_payments_clp: number;
  /** Ledger historial only when `has_installment_ledger`. */
  ledger_remaining_installments_clp?: number;
}

/** One point in the server-built dense Historial chart series. */
export type CcHistorialChartPoint = {
  month: string;
  installment_payments_clp: number;
  facturado_clp: number | null;
  cupo_en_cuotas_clp: number | null;
  balance_total_clp: number | null;
};

/** One point in the server-built dense billing-month chart series. */
export type CcBillingMonthChartPoint = {
  billing_month: string;
  facturado_clp: number | null;
  facturado_usd_clp: number | null;
  financing_cost_clp: number | null;
  ytd_financing_cost_clp: number | null;
};

export interface CcProxyCuotaResult {
  pay_by_date: string;
  billing_month: string;
  cuota_amount_clp: number;
  realized_gain_clp: number;
  accumulated_gain_clp: number;
  accumulated_return_pct: number;
  projected: boolean;
}

export interface CcProxyTickerResult {
  gain_clp: number;
  return_pct: number;
  projected: boolean;
  cuotas: CcProxyCuotaResult[];
}

export interface CcProxyLotResult {
  by_ticker: Record<string, CcProxyTickerResult>;
}

export interface CcProxyFacturacionAggregate {
  billing_month: string;
  by_ticker: Record<string, {
    total_gain_clp: number;
    blended_return_pct: number;
    projected: boolean;
  }>;
}

export interface AccountCcInstallmentsResponse {
  account_id: number;
  has_installment_ledger: boolean;
  has_imported_statements: boolean;
  meta: AccountCcInstallmentsMeta | null;
  purchases: CcInstallmentPurchaseComputed[];
  /** Compras en cuotas ya liquidadas (restan 0 y saldo 0). */
  purchases_completed: CcInstallmentPurchaseComputed[];
  /** Hidden from cuotas tables because they were cancelled/reimbursed by later credit notes. */
  hidden_cancelled_purchases?: CcInstallmentPurchaseComputed[];
  months: CcInstallmentMonthRow[];
  totals: {
    total_remaining_principal_clp: number;
    next_calendar_month_total_clp: number | null;
    next_calendar_month: string | null;
  };
  /** End-of-month outstanding installment principal vs cuotas pagadas (ledger import). */
  installment_history_months?: CcInstallmentHistoryMonthPoint[];
  statements?: CcStatementDto[];
  billing_month_balances?: CcBillingMonthBalanceDto[];
  billing_detail_by_month?: CcBillingDetailMonthDto[];
  facturaciones?: CcFacturacionDto[];
  financing_pl_by_month?: CcFinancingPlMonthDto[];
  billing_config?: CreditCardBillingConfigDto;
  /** Open facturación month for manual / web-paste (`YYYY-MM`). */
  open_billing_month?: string | null;
  /** Distinct physical card numbers billed on this master (titular first). */
  associated_card_last4s?: string[];
  /** Dense Historial chart series — interior month gaps filled with nulls. Built server-side. */
  historial_chart?: CcHistorialChartPoint[];
  /** Dense billing-month chart series — interior month gaps filled with nulls. Built server-side. */
  billing_month_chart?: CcBillingMonthChartPoint[];
  /** Tracked tickers for proxy earnings computation. */
  proxy_tickers?: string[];
  /** Per-installment-purchase proxy earnings, keyed by purchase_db_id. */
  purchase_proxy?: Record<number, CcProxyLotResult>;
  /** Per-facturación aggregated proxy earnings (installments + normal purchases). */
  facturacion_proxy?: CcProxyFacturacionAggregate[];
}

export type CcCupoEntry = { currency: "clp" | "usd"; value: number | null };

/** `GET /api/accounts/:id/credit-card-config` — editable `credit_card_account_config` row. */
export type CreditCardAccountConfigDto = {
  account_id: number;
  card_last4: string | null;
  billing_cycle_start_day: number;
  /** Raw column value; billing math treats null as day 20. */
  billing_cycle_end_day: number | null;
  cupo: CcCupoEntry[];
};

export type CreditCardConfigPatchBody = {
  billing_cycle_start_day?: number;
  billing_cycle_end_day?: number | null;
  cupo?: CcCupoEntry[];
};

/** `GET /api/portfolio-groups/:slug/cc-ledger` — aggregated CC masters for a pasivos group. */
export type PortfolioGroupCcLedgerResponse = AccountCcInstallmentsResponse;

/** `GET /api/portfolio-groups/:slug/mortgage-ledger` — mortgage sheet for liabilities groups. */
export type PortfolioGroupMortgageLedgerResponse = AccountMortgageLedgerResponse;
