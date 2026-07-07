import type { AccountListRow, AccountPositionSnapshot } from "./core";
import type { AccountCcInstallmentsResponse } from "./creditCard";
import type { DashboardAccountRow, TimeseriesBlock } from "./dashboard";
import type { AccountDepositInflowsResponse, AccountMortgageLedgerResponse, DeptoMortgageSheetRow } from "./mortgage";

import type { BookLedgerEditSchema } from "../accountBookLedgerEdit";
import type { MovementCreateSchema } from "../accountMovementCreate";

/** `GET /api/accounts/:id/valuation-timeseries` */
export interface AccountValuationTimeseriesResponse {
  unit: "clp" | "usd" | "uf";
  account_id: number;
  name: string;
  accounts: TimeseriesBlock;
  allocation_pie: { name: string; account_id: number; value: number }[];
  /** `daily` only when the account supports it (SPY/VEA MTM + `equity_daily`); otherwise `monthly`. */
  granularity: "monthly" | "daily";
}

/** `GET /api/accounts/:id/performance-monthly` — derived, not stored. */
export interface AccountMonthlyPerformanceRow {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  /** Sum units added in the month: equity buys + DRIP (`movements.units_delta > 0` with `flow_kind`), or for **afp** certificate cuotas on AFP import rows. */
  stock_units_inflow: number;
  /** Coin balance at month-end (bitcoin / eth). */
  coin_units_eom?: number | null;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
  /** Mortgage: crédito restante (UF) from depto dividendos sheet at month-end. */
  closing_balance_uf?: number | null;
  /** Mortgage: UF/CLP rate from depto dividendos sheet at month-end. */
  uf_clp_day?: number | null;
  unit: "clp" | "usd" | "uf";
}

export interface AccountMonthlyPerformanceResponse {
  account_id: number;
  category_slug: string;
  monthly: AccountMonthlyPerformanceRow[];
}

export interface MortgagePaymentCreateSchema {
  next_cuota: string;
  default_incendio_clp: number | null;
}

export interface MortgagePaymentPreviewResponse {
  sheet: DeptoMortgageSheetRow;
  input: {
    occurred_on: string;
    pago_clp: number;
    interes_clp: number;
    incendio_clp: number;
    desgravamen_clp?: number | null;
    cuota?: string | null;
    amortizacion_ext_clp?: number | null;
  };
  desgravamen_default_clp: number;
  desgravamen_used_override: boolean;
  property_net_clp: number;
  mortgage_balance_clp: number;
}

export interface MortgagePaymentCommitResponse {
  sheet_row: DeptoMortgageSheetRow;
  mortgage_movement_id: number;
  property_movement_id: number;
  sort_order: number;
}

/** `GET /api/accounts/:id/summary` */
export interface AccountSummaryResponse {
  account_id: number;
  category_slug: string | null;
  group_slug: string | null;
  group_label: string | null;
  group_peer_count: number | null;
  /** Quote currency of `accounts.equity_ticker` (clp for Bolsa de Santiago `.SN`); null for non-equity accounts. */
  equity_quote_currency?: "usd" | "clp" | null;
  deposits_clp: number;
  withdrawals_clp: number;
  latest_valuation_clp: number | null;
  latest_valuation_date: string | null;
  position: AccountPositionSnapshot | null;
  movement_create?: MovementCreateSchema;
  book_ledger_edit?: BookLedgerEditSchema;
  mortgage_payment_create?: MortgagePaymentCreateSchema;
}

/** `GET /api/accounts/:id/detail-bundle` */
export interface AccountDetailBundleResponse {
  summary: AccountSummaryResponse;
  ts: AccountValuationTimeseriesResponse | null;
  depositInflows: AccountDepositInflowsResponse;
  mortgageLedger: AccountMortgageLedgerResponse;
  ccLedger: AccountCcInstallmentsResponse;
  invNavAccounts: { accounts: AccountListRow[] };
  checkingCartolaMonths: CheckingCartolaMonthsResponse | null;
  monthly_performance: AccountMonthlyPerformanceResponse | null;
  /** Fresh dashboard card row (live MTM + perf deltas); do not use cached nav snapshot on detail. */
  dashboard_account_row: DashboardAccountRow | null;
}

export interface CheckingCartolaMonthRowDto {
  period_month: string;
  as_of_date: string;
  source_file: string;
  has_cartola: boolean;
  deposits_clp: number;
  withdrawals_clp: number;
  balance_end_clp: number | null;
  /** Parsed cartola saldo final (reference only). */
  cartola_saldo_final_clp: number | null;
  /** Parsed cartola saldo inicial (prior month-end per statement). */
  cartola_saldo_inicial_clp: number | null;
  movement_count: number;
  imported_at: string | null;
}

export interface CheckingLedgerAnchorDto {
  movement_id: number;
  amount_clp: number;
  occurred_on: string;
  anchor_period_month: string;
  cartola_saldo_final_clp: number;
  cartola_derived_amount_clp: number;
}

export interface CartolaDerivedAnchorDto {
  period_month: string;
  occurred_on: string;
  amount_clp: number;
}

export interface CheckingCartolaMonthsResponse {
  account_id: number;
  imported_months: string[];
  rows: CheckingCartolaMonthRowDto[];
  ledger_anchor: CheckingLedgerAnchorDto | null;
  cartola_derived_anchor: CartolaDerivedAnchorDto | null;
}
