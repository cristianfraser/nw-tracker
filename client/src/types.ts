import type { BookLedgerEditSchema } from "./accountBookLedgerEdit";
import type { MovementCreateSchema } from "./accountMovementCreate";
import type { DataOrigin } from "./dataOrigin";

export type AssetGroupSlug =
  | "retirement"
  | "brokerage"
  | "inversiones"
  | "cash_eqs"
  | "crypto"
  | "real_estate"
  | "liabilities";

export interface AccountListRow {
  id: number;
  name: string;
  notes: string | null;
  created_at: string;
  category_slug: string;
  category_label: string;
  group_slug: string;
  group_label: string;
  /** Leaf bucket placement (`asset_groups.slug`). */
  bucket_slug?: string;
  bucket_label?: string;
  /** When 1, account is listed in nav but omitted from class totals and dashboard buckets. */
  exclude_from_group_totals?: number;
  /** Chart line color as `r,g,b` (0–255). */
  color_rgb?: string | null;
  /** Pasivos liability_view → master account for valuations / P/L. */
  source_account_id?: number | null;
  /** Long trailing-zero tail; hidden from nav child cards, kept in group charts/tables. */
  chart_inactive?: boolean;
}

export type PortfolioTreeNodeDto =
  | {
      kind: "group";
      id: number;
      slug: string;
      label: string;
      sort_order: number;
      color_rgb: string;
      color: string;
      children: PortfolioTreeNodeDto[];
    }
  | {
      kind: "account";
      account_id: number;
      name: string;
      sort_order: number;
      color_rgb: string;
      color: string;
    };

export interface PortfolioTreeResponse {
  roots: PortfolioTreeNodeDto[];
}

export interface AccountPositionSnapshot {
  ticker: string;
  units_kind: "shares" | "coin";
  units: number | null;
  deposited_clp: number;
  value_clp: number | null;
  value_as_of: string | null;
  value_per_unit_clp: number | null;
  dividends_reinvested_clp?: number;
  cost_basis_clp?: number;
  total_return_clp?: number | null;
  return_on_deposited_pct?: number | null;
  naive_gain_clp?: number | null;
}

export interface FxCoverage {
  complete: boolean;
  first_missing_date: string | null;
  missing_count: number;
  fx_min: string | null;
  fx_max: string | null;
  daily_count: number;
  row_count: number;
  is_sparse: boolean;
  max_gap_days: number;
  yahoo_rejected: { date: string; raw_clp_per_usd: number; reason: string }[];
  conversion_warnings?: FxConversionWarning[];
}

export type FxConversionWarningCode =
  | "buy_rate_missing"
  | "sell_rate_missing"
  | "usd_reference_clp";

export interface FxConversionWarning {
  code: FxConversionWarningCode;
  date: string;
  context?: string;
}

export interface FxBidAskGapRow {
  date: string;
  mid_clp_per_usd: number | null;
  buy_clp_per_usd: number | null;
  sell_clp_per_usd: number | null;
  source: string | null;
  suggested_buy: number | null;
  suggested_sell: number | null;
}

export interface DashboardAccountRow {
  account_id: number;
  name: string;
  notes?: string | null;
  group_slug: string;
  group_label: string;
  bucket_slug?: string;
  bucket_label?: string;
  /** Top-level NW dashboard bucket from asset_groups ancestry (server-computed). */
  dashboard_bucket_slug?: string;
  /** Optional on dashboard/page-bundle rows (server `DashboardAccountStats.category_slug?`). */
  category_slug?: string;
  category_label: string;
  deposits_clp: number;
  deposits_usd?: number | null;
  /** Nominal P/L for the current calendar month (or latest month in series). */
  delta_month_clp?: number | null;
  delta_month_usd?: number | null;
  delta_year_clp?: number | null;
  delta_year_usd?: number | null;
  delta_total_clp?: number | null;
  delta_total_usd?: number | null;
  deposits_month_clp?: number;
  deposits_month_usd?: number | null;
  deposits_year_clp?: number;
  deposits_year_usd?: number | null;
  prior_month_close_clp?: number | null;
  prior_month_close_usd?: number | null;
  prior_year_close_clp?: number | null;
  prior_year_close_usd?: number | null;
  current_value_clp: number | null;
  valuation_as_of: string | null;
  current_value_usd?: number | null;
  fx_clp_per_usd?: number | null;
  fx_date_used?: string | null;
  /** USD display could not resolve FX for balance or deposits. */
  fx_missing?: boolean;
  position?: AccountPositionSnapshot | null;
  /** True when monthly closes show a long zero tail (same rule as chart tail clip). From `/api/dashboard`. */
  chart_inactive?: boolean;
  /** When 1, listed in nav/charts but omitted from bucket totals, class Total, NW cash bucket. */
  exclude_from_group_totals?: number;
  /** True when any linked global sync source is currently stale. */
  sync_stale?: boolean;
}

export interface DashboardLinkedBalanceRow {
  slug: string;
  label: string;
  label_i18n_key: string;
  clp: number;
  usd?: number | null;
  route_path: string;
}

export interface DashboardLayoutCardRow {
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  bucket_slug: string;
  card_css: string | null;
  route_path?: string | null;
  linked_balances?: DashboardLinkedBalanceRow[];
}

export interface DashboardBucketCloseTotals {
  net_worth_clp: number;
  real_estate_clp: number;
  retirement_clp: number;
  brokerage_clp: number;
  cash_eqs_clp: number;
  net_worth_usd?: number | null;
  real_estate_usd?: number | null;
  retirement_usd?: number | null;
  brokerage_usd?: number | null;
  cash_eqs_usd?: number | null;
}

export interface DashboardPriorCloses {
  month_end: string;
  year_end: string;
  month: DashboardBucketCloseTotals;
  year: DashboardBucketCloseTotals;
}

export interface DashboardResponse {
  totals: {
    net_worth_clp: number;
    deposits_clp: number;
    real_estate_clp: number;
    retirement_clp: number;
    brokerage_clp: number;
    cash_eqs_clp: number;
    liabilities_clp: number;
    /** Prior period closes from the same bucket valuation function as live totals. */
    prior_closes: DashboardPriorCloses;
    net_worth_usd?: number | null;
    deposits_usd?: number | null;
    real_estate_usd?: number;
    retirement_usd?: number;
    brokerage_usd?: number;
    cash_eqs_usd?: number;
    liabilities_usd?: number;
  };
  allocation: {
    group_slug: string;
    group_label: string;
    value_clp: number;
    value_usd?: number;
    /** `portfolio_groups` resolved color (`r,g,b`). */
    color_rgb?: string;
  }[];
  accounts: DashboardAccountRow[];
  liabilities_breakdown?: {
    mortgage_clp: number;
    credit_card_clp: number;
    mortgage_usd?: number | null;
    credit_card_usd?: number | null;
  };
  /** Pasivos > tarjeta de crédito leaves (same source as liabilities sidebar). */
  cash_credit_card_links?: {
    liability_account_id: number;
    operational_account_id: number;
    name: string;
    clp: number;
    usd?: number | null;
  }[];
  deposits_by_category?: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number | null }
  >;
  /** Retiro + brokerage net deposits per period (flows chart aggregation). */
  inversiones_deposits_chart?: {
    monthly_clp: { as_of_date: string; deposited: number }[];
    yearly_clp: { as_of_date: string; deposited: number }[];
    monthly_usd?: { as_of_date: string; deposited: number }[];
    yearly_usd?: { as_of_date: string; deposited: number }[];
  };
  /** Home bucket cards (order + bucket) from `portfolio_groups`; Patrimonio neto hero is not included. */
  dashboard_layout?: DashboardLayoutCardRow[];
  /** True when deposit USD totals could not be converted (missing fx_daily). */
  fx_conversion_error?: boolean;
  fx_conversion_warnings?: FxConversionWarning[];
  /** Current-month Patrimonio neto metrics from canonical consolidated series (card period row). */
  net_worth_period_metrics?: {
    closing_clp: number;
    prior_closing_clp: number | null;
    net_capital_flow_clp: number;
    nominal_pl_clp: number | null;
    balance_delta_clp: number | null;
  } | null;
}

export interface FxLatest {
  date: string;
  clp_per_usd: number;
}

export interface UfLatest {
  date: string;
  clp_per_uf: number;
}

/** `data` = account valuation / flows (tail-clip trailing zeros). `reference` = totals, NW, liquidity overlays. */
export type ValueSeriesType = "data" | "reference";

export interface TimeseriesAccountLine {
  account_id: number;
  name: string;
  dataKey: string;
  /** Set on every chart line: `data` = clip trailing zeros; `reference` = totals / overlays (not clipped). */
  valueSeriesType: ValueSeriesType;
  /** Cumulative deposits (CLP) through each date, same unit as valuations; thinner line in UI */
  depositDataKey?: string;
  /** Legend label for the deposit line when not the default "aportes acum." */
  deposit_series_name?: string;
  /** Personal deposits only (excludes APV-A state bonus) when present */
  displayDepositDataKey?: string;
  display_deposit_series_name?: string;
  /** Omitted from class “Total” / dashboard buckets; still shown as its own line. */
  exclude_from_group_totals?: boolean;
  /** Chart line color as `r,g,b` (0–255), from DB. */
  color_rgb?: string;
}

export interface TimeseriesBlock {
  accounts?: TimeseriesAccountLine[];
  lines?: {
    dataKey: string;
    name: string;
    valueSeriesType: ValueSeriesType;
    /** Resolved from `portfolio_groups` for dashboard overview buckets. */
    color_rgb?: string;
  }[];
  points: Record<string, string | number | null>[];
  /** Server: portfolio group color (or resolver fallback) for synthetic aggregated lines; keys like `"-203"`. */
  synthetic_group_color_rgb?: Record<string, string>;
  /** FX-backed USD milestone CLP levels for chart anchor dates (month/year prior period ends). */
  referenceMilestoneByDate?: Record<string, Record<string, number | null>>;
  /** Server tail-clip: last visible date when every data series ends early (x-axis stops here). */
  chart_end_ymd?: string;
  /** Server tail-clip: data keys whose tails were nulled (`connectNulls={false}` on these lines). */
  tail_clipped_keys?: string[];
}

/** Dashboard home, or `/api/...?group=` for class tabs */
export interface ValuationTimeseriesResponse {
  unit: "clp" | "usd" | "uf";
  accounts_ex_property?: TimeseriesBlock;
  overview?: Required<Pick<TimeseriesBlock, "lines" | "points">>;
  /** Patrimonio neto + invested (CLP) and USD milestone reference lines (CLP via FX). */
  patrimonio_usd_milestones_chart?: TimeseriesBlock;
  group_slug?: string;
  /** Whole class tab: all accounts on one line chart (+ deposit lines) */
  accounts_in_group?: TimeseriesBlock;
  group_allocation_pie?: { name: string; account_id: number; value: number }[];
}

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
  month: string;
  total_clp: number;
  breakdown: CcInstallmentMonthBreakdown[];
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
  deposits_full_clp?: number;
  dividends_reinvested_clp?: number;
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

/** `GET /api/groups/:slug/performance-monthly` — derived, not stored. */
export interface GroupMonthlyPerformanceBarAccount {
  account_id: number;
  name: string;
  bar_data_key: string;
  color_rgb?: string;
}

export interface GroupMonthlyPerformanceResponse {
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
}

export interface DashboardChartShapeLine {
  dataKey: string;
  name: string;
  valueSeriesType: ValueSeriesType;
  account_id?: number;
  color_rgb?: string;
}

/**
 * Dashboard chart skeleton — line specs, x-axis start, and which optional sections exist —
 * so every chart/section mounts empty (correct shape) before the page bundle resolves.
 */
export interface DashboardChartShape {
  /** Earliest valuation date; chart x-axes start on its month. Null on an empty DB. */
  first_month: string | null;
  overview_lines: DashboardChartShapeLine[];
  primary_lines: DashboardChartShapeLine[];
  has_patrimonio_usd_chart: boolean;
  has_perf_sections: boolean;
}

/** `GET /api/dashboard/nav-snapshot` — card strip shape (no valuation TS). */
export interface DashboardNavSnapshotResponse {
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  nw_bucket_totals: DashboardNavContextResponse["nw_bucket_totals"];
  chart_shape?: DashboardChartShape;
}

/**
 * Nav snapshot as read from a persisted cache: entries written by older app versions may
 * predate `liabilities_breakdown` / `nw_bucket_totals` (placeholder paths guard for this).
 */
export type CachedDashboardNavSnapshot = Omit<
  DashboardNavSnapshotResponse,
  "liabilities_breakdown" | "nw_bucket_totals"
> &
  Partial<Pick<DashboardNavSnapshotResponse, "liabilities_breakdown" | "nw_bucket_totals">>;

/** `GET /api/dashboard/nav-context` — nav strip + overview in one response. */
export interface DashboardNavContextResponse {
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  cash_credit_card_links: DashboardResponse["cash_credit_card_links"];
  /** Live NW bucket totals + prior closes (same as page-bundle `dash.totals` buckets). */
  nw_bucket_totals: Pick<
    DashboardResponse["totals"],
    | "net_worth_clp"
    | "real_estate_clp"
    | "retirement_clp"
    | "brokerage_clp"
    | "cash_eqs_clp"
    | "prior_closes"
  > &
    Partial<
      Pick<
        DashboardResponse["totals"],
        "net_worth_usd" | "real_estate_usd" | "retirement_usd" | "brokerage_usd" | "cash_eqs_usd"
      >
    >;
  overview: ValuationTimeseriesResponse["overview"];
  fx_coverage: FxCoverage | null;
  /** Month/year metrics for the inversiones nav hub (canonical consolidated series). */
  inversiones_period_metrics?: {
    month: {
      closing_clp: number;
      prior_closing_clp: number | null;
      net_capital_flow_clp: number;
      nominal_pl_clp: number | null;
      balance_delta_clp: number | null;
    } | null;
    year: {
      closing_clp: number;
      prior_closing_clp: number | null;
      net_capital_flow_clp: number;
      nominal_pl_clp: number | null;
      balance_delta_clp: number | null;
    } | null;
  };
}

/** `GET /api/dashboard/page-bundle` — home dashboard in one response. */
export interface DashboardPageBundleResponse {
  dash: DashboardResponse;
  ts: ValuationTimeseriesResponse;
  fx: FxLatest | null;
  fx_coverage: FxCoverage | null;
  retirementPerf: GroupMonthlyPerformanceResponse | null;
  brokeragePerf: GroupMonthlyPerformanceResponse | null;
}

export type ConsolidatedMonthlyPerfRow = {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
};

export interface GroupConsolidatedTablesResponse {
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
    notes: string | null;
    monthly: AccountMonthlyPerformanceRow[];
  }[];
  consolidated_monthly: ConsolidatedMonthlyPerfRow[];
}

/** Server-side paginated response shape. */
export type Paginated<T> = {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
};

/** `GET /api/groups/:slug/consolidated-monthly` — server-paginated detalle por mes. */
export type GroupConsolidatedMonthlyPageResponse = Paginated<ConsolidatedMonthlyPerfRow> & {
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  period: "month" | "year";
};

/** `GET /api/groups/:slug/flows` and `GET /api/accounts/:id/flows` */
export type FlowsApiRow = {
  id: number;
  key: string;
  account_id: number;
  account_name: string;
  category_slug: string;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  amount_usd: number | null;
  ticker: string | null;
  flow_type: string;
  flow_type_label: string;
  counterpart_account_id: number | null;
  counterpart_account_name: string | null;
  transfer_direction: "out" | "in" | null;
};

export type FlowsFilterOptions = {
  years: string[];
  types: { value: string; label: string }[];
  accounts: { id: number; name: string }[];
  categories: string[];
};

export type FlowsPageResponse = Paginated<FlowsApiRow> & {
  filter_options: FlowsFilterOptions;
};

/** `GET /api/dashboard/stocks-earnings-monthly` — merged SPY+VEA (or single), derived. */
export interface StocksLifetimeEarningsResponse {
  unit: "clp" | "usd" | "uf";
  stock_accounts: { account_id: number; name: string }[];
  points: { as_of_date: string; delta_month: number; accumulated_earnings: number; ytd_merged: number }[];
}

/** `GET /api/market-series` — sparse observations per field (no cross-series forward-fill); CLP crosses use FX on or before each equity/fund observation date. */
export interface MarketSeriesPoint {
  as_of_date: string;
  clp_per_usd: number | null;
  clp_per_uf: number | null;
  clp_per_eur: number | null;
  ipc_index: number | null;
  equity_usd: Record<string, number | null>;
  equity_clp: Record<string, number | null>;
  fund_unit_clp: Record<string, number | null>;
  fund_unit_usd: Record<string, number | null>;
}

export interface MarketSeriesResponse {
  points: MarketSeriesPoint[];
  equity_tickers: string[];
  fund_series_keys: string[];
  fx_usd_clp: { date: string; value: number }[];
  fx_usd_clp_bcentral: { date: string; value: number }[];
  fx_usd_clp_buy?: { date: string; value: number }[];
  fx_usd_clp_sell?: { date: string; value: number }[];
  eur_clp: { date: string; value: number }[];
  fx_coverage: FxCoverage;
}

/** `GET /api/market-ticker` — Chile-today snapshot for the marquee (not forward-filled series tail). */
export interface MarketDisplaySeriesRow {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: "equity" | "fund_unit" | "fx_usd" | "uf" | "composite";
  series_key: string | null;
  show_in_marquee: number;
  show_in_rates: number;
  rates_chart_title: string | null;
  source: "builtin" | "account" | "manual";
}

export interface WatchlistChanges {
  day_pct: number | null;
  week_pct: number | null;
  mtd_pct: number | null;
  mom_pct: number | null;
  ytd_pct: number | null;
  yoy_pct: number | null;
  y3_pct: number | null;
  y5_pct: number | null;
  y10_pct: number | null;
}

export interface WatchlistCompositeHoldingRow {
  ticker: string;
  weight: number;
  value: number | null;
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
}

export interface WatchlistRow extends MarketDisplaySeriesRow {
  value: number | null;
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
  composite_holdings?: WatchlistCompositeHoldingRow[];
}

export interface WatchlistResponse {
  app: WatchlistRow[];
  manual: WatchlistRow[];
}

export interface MarketTickerResponse {
  chile_today: string;
  uf: { date: string; clp_per_uf: number } | null;
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  risky_norris: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  risky_norris_proxy: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  equities: {
    ticker: string;
    trade_date: string;
    value: number;
    /** Exchange quote currency for `value` (CLP for Bolsa de Santiago tickers). */
    currency: "usd" | "clp";
    delta_pct: number | null;
    source?: "live" | "eod";
  }[];
  marquee_series?: MarketDisplaySeriesRow[];
}

export interface NavTreeNodeDto {
  node_id: string;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  active_prefix: string | null;
  nav_end: boolean;
  show_leaf_hyphen: boolean;
  account_id: number | null;
  portfolio_group_id: number | null;
  /** Master account when `account_id` is a liability-view leaf (CC purchases, cupo, ledger). */
  source_account_id: number | null;
  expense_account_id: number | null;
  expense_account_slug: string | null;
  asset_group_slug: string | null;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total?: boolean;
  api_group: string | null;
  api_subgroup: string | null;
  color_rgb: string | null;
  color: string | null;
  /** `nav_bucket` = sidebar grouping only (e.g. inversiones, efectivo). */
  group_kind: "bucket" | "reference" | "nav_bucket" | "liability_group";
  /** Long zero tail: listed for chart history; omitted from group tables and strip cards. */
  chart_inactive?: boolean;
  children: NavTreeNodeDto[];
}

export interface SidebarNavResponse {
  dashboard: NavTreeNodeDto | null;
  /** `portfolio_groups.slug = net_worth` — label for home route and page title. */
  net_worth: NavTreeNodeDto | null;
  main: NavTreeNodeDto[];
  flows: NavTreeNodeDto | null;
  search: NavTreeNodeDto | null;
  projections: NavTreeNodeDto | null;
  rates: NavTreeNodeDto | null;
}

export interface RatesInstrumentsResponse {
  instruments: MarketDisplaySeriesRow[];
}

export type DepositFlowCategory = "real_estate" | "cash" | "brokerage" | "inversiones";

export interface FlowDepositRow {
  occurred_on: string;
  category: DepositFlowCategory;
  category_label: string;
  account_id: number;
  account_name: string;
  amount_clp: number;
  amount_usd: number | null;
}

export interface FlowDepositChartPoint {
  as_of_date: string;
  real_estate: number;
  cash: number;
  brokerage: number;
  inversiones: number;
  total: number;
}

export type ExpenseApartmentSlug = "el_vergel" | "lastarria" | "suecia";

export interface FlowExpenseChartPoint {
  as_of_date: string;
  real_estate: number;
  lastarria: number;
  suecia: number;
  el_vergel: number;
  total: number;
}

export interface FlowCcExpenseMonthRow {
  period_month: string;
  as_of_date: string;
  gastos_mes_clp: number;
  gastos_real_mes_clp: number;
  abonos_mes_clp: number;
  gastos_acumulado_clp: number;
  gastos_real_acumulado_clp: number;
  line_count: number;
}

export interface FlowCcExpenseChartPoint {
  as_of_date: string;
  gastos_clp: number;
}

export interface CcExpenseCategoryDto {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  chart_color: string;
}

export interface CcExpenseBigGroupDto {
  slug: string;
  label: string;
  sort_order: number;
}

export type FlowCcExpenseLineSource = "cc" | "checking" | "manual";

/** Installment-mode scope override; default `both`. See ccExpensePeriodMonth.ts. */
export type CcFacturadoFinancingGastosScope = "both" | "total_only" | "split_only" | "excluded";

/** A facturado paid in cuotas via a set of installment purchases. */
export interface CcFacturadoFinancingLink {
  id: number;
  financed_account_id: number;
  financed_billing_month: string;
  financing: { account_id: number; purchase_key: string }[];
}

export interface FlowCcExpenseLineRow {
  source: FlowCcExpenseLineSource;
  statement_line_id: number;
  account_id: number;
  /** Calendar month bucket (YYYY-MM). */
  expense_month: string;
  /**
   * Optional override for gastos chart / month table / modal bucketing only.
   * purchase_on and purchase_month stay on the real transaction date.
   */
  gastos_period_month?: string;
  /** Facturación month (CC); same as expense_month for checking. */
  billing_month: string;
  /** Calendar month of purchase (YYYY-MM). */
  purchase_month: string;
  line_role: "purchase" | "installment_cuota" | "installment_purchase_total";
  /** Ledger total for installment lines (disambiguates same-identity purchase_keys). */
  installment_total_clp?: number | null;
  /** Installment-mode scope override (facturado-financing projection); default `both`. */
  gastos_scope?: CcFacturadoFinancingGastosScope;
  occurred_on: string;
  purchase_on: string | null;
  statement_date: string;
  amount_clp: number;
  /** Original USD when the charge is on a USD statement (or USD-only line). */
  amount_usd?: number | null;
  /** USD for gastos display: native USD or CLP ÷ FX on purchase / movement date. */
  amount_usd_at_expense: number | null;
  merchant: string | null;
  merchant_key: string;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  category_slug: string;
  category_unique: boolean;
  /** Set when a NOTA DE CREDITO annuls or adjusts prior card charges. */
  nota_credito_role?: "annulled_purchase" | "matched_nota" | "unmatched_nota";
  /** Statement line id used for category / unique PATCH (installment purchase totals). */
  category_statement_line_id?: number | null;
  /** Stable purchase identity (cuota, one-shot, synthetic total). */
  purchase_key: string;
  /** User note for this purchase (shared across cuotas / synthetic total). */
  purchase_notes: string;
  /** Optional big expense group (trip, remodeling, etc.). */
  big_group_slug: string | null;
  /** Card last4 (CC) or full account name (checking). */
  origin_label: string;
  /** Physical card that made the charge; null = primary / unknown / checking. */
  origin_card_last4?: string | null;
  /** Statement billing card; null for checking / synthetic lines. */
  primary_card_last4?: string | null;
  /** Linked net-worth deposits (investment capital + mortgage amortization splits). */
  expense_deposit_links?: ExpenseDepositLinkDto[];
}

export interface ExpenseDepositLinkDto {
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  carrying_clp: number;
  depto_cuota: string | null;
  depto_occurred_on: string | null;
  link_source: "auto" | "manual";
}

export type FlowCcExpenseCategoryChartPoint = {
  as_of_date: string;
  [categorySlug: string]: string | number;
};

export type DepositReconciliationStatus =
  | "linked"
  | "linked_synthetic"
  | "resolved_family_funded"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export interface DepositReconciliationRow {
  movement_id: number;
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  amount_clp: number;
  amount_usd: number | null;
  status: DepositReconciliationStatus;
}

export interface DepositReconciliationStatusTotals {
  count: number;
  total_clp: number;
  total_usd: number | null;
}

export interface DepositReconciliationByMonth {
  month: string;
  linked_clp: number;
  linked_synthetic_clp: number;
  resolved_family_funded_clp: number;
  resolved_internal_transfer_clp: number;
  unlinked_no_checking_source_clp: number;
  unlinked_checking_present_clp: number;
  total_clp: number;
}

export type DepositRedemptionStatus =
  | "linked"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export interface DepositRedemptionRow {
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  amount_clp: number;
  amount_usd: number | null;
  status: DepositRedemptionStatus;
}

/** Checking outflow manually categorized as `deposits` — asserts a matching deposit exists. */
export type DepositManualAssertionStatus = "linked" | "asserted_unmatched";

export interface DepositManualAssertionRow {
  purchase_key: string;
  account_id: number;
  account_name: string;
  occurred_on: string;
  merchant: string | null;
  amount_clp: number;
  amount_usd: number | null;
  deposit_movement_id: number | null;
  deposit_account_id: number | null;
  deposit_account_name: string | null;
  candidate_count: number;
  status: DepositManualAssertionStatus;
}

export interface DepositsReconciliationPayload {
  rows: DepositReconciliationRow[];
  by_status: Record<DepositReconciliationStatus, DepositReconciliationStatusTotals>;
  by_month: DepositReconciliationByMonth[];
  redemptions: DepositRedemptionRow[];
  redemptions_by_status: Record<DepositRedemptionStatus, DepositReconciliationStatusTotals>;
  manual_assertions: DepositManualAssertionRow[];
  fx_conversion_error: boolean;
  fx_conversion_warnings: unknown[];
}

/** `GET /api/flows/expenses/credit-card` — Pasivos tarjeta de crédito (grupo, líneas de estado de cuenta). */
export interface FlowsCreditCardExpensesResponse {
  group_slug: string;
  account_ids: number[];
  categories: CcExpenseCategoryDto[];
  big_groups: CcExpenseBigGroupDto[];
  lines: FlowCcExpenseLineRow[];
  by_month: FlowCcExpenseMonthRow[];
  chart_monthly: FlowCcExpenseChartPoint[];
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  total_clp: number;
  total_real_clp: number;
  /** Tracked tickers used to compute proxy earnings. */
  proxy_tickers?: string[];
  /**
   * Investment proxy earnings for normal (non-installment) purchase lines,
   * keyed by statement_line_id.
   */
  line_proxy?: Record<number, CcProxyLotResult>;
}

/** `GET /api/income` — cartola abonos + manual income_entries. */
export interface FlowCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  source: "checking";
}

export interface FlowExcludedCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  note: string | null;
}

export type IncomeAutoFilterReason =
  | "excluded_description"
  | "mercado_capitales_reversal"
  | "internal_withdrawal"
  | "afp_retiro_return"
  | "net_worth_capital_return";

export interface FlowFilteredCheckingIncomeLine {
  movement_id: number;
  account_id: number;
  account_label: string;
  received_on: string;
  amount_clp: number;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  description: string;
  filter_reason: IncomeAutoFilterReason;
}

export interface FlowManualIncomeLine {
  id: number;
  amount_clp: number;
  received_on: string;
  /** CLP ÷ `fx_daily` on or before `received_on`. */
  amount_usd: number | null;
  source: string | null;
  note: string | null;
  origin: "manual";
}

export interface FlowsIncomeResponse {
  lines: FlowCheckingIncomeLine[];
  manual: FlowManualIncomeLine[];
  monthly_totals: Record<string, number>;
  work_earnings: FlowWorkEarningRow[];
  income_kind_by_movement_id: Record<number, IncomeKind>;
  payroll_period_by_movement_id: Record<number, string>;
  excluded_lines: FlowExcludedCheckingIncomeLine[];
  filtered_lines: FlowFilteredCheckingIncomeLine[];
}

export type PayrollEarningType = "salary" | "severance";
export type PayrollLinkSource = "auto" | "manual";

export interface FlowWorkEarningRow {
  id: number;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type: PayrollEarningType;
  base_salary_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
  gratificacion_clp: number | null;
  total_imponible_clp: number | null;
  total_no_imponible_clp: number | null;
  total_haberes_clp: number | null;
  desc_afp_clp: number | null;
  desc_health_clp: number | null;
  desc_tax_clp: number | null;
  desc_cesantia_clp: number | null;
  desc_apv_clp: number | null;
  desc_other_clp: number | null;
  total_descuentos_clp: number | null;
  liquido_clp: number;
  liquido_usd: number | null;
  wire_received_on: string | null;
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  source_pdf: string;
  movement_id: number | null;
  link_source: PayrollLinkSource | null;
  linked_received_on: string | null;
  linked_amount_clp: number | null;
  linked_account_label: string | null;
}

export type IncomeKind = PayrollEarningType | "other" | "parent_gift";

export interface FlowIncomeMonthRow {
  period_month: string;
  as_of_date: string;
  salary_clp: number;
  severance_clp: number;
  parent_gift_clp: number;
  other_clp: number;
  total_clp: number;
  line_count: number;
  cumulative_clp: number;
}

export interface FlowIncomeChartPoint {
  as_of_date: string;
  salary: number;
  severance: number;
  parent_gift: number;
  other: number;
  total: number;
}

export type RealEstateExpenseLinkSource = "auto" | "manual";

export interface RealEstateExpenseLinkDto {
  purchase_key: string;
  link_source: RealEstateExpenseLinkSource;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
}

export interface RealEstateBillSlot {
  expense_entry_id: number;
  account_slug: ExpenseApartmentSlug;
  bill_month: string;
  spent_on: string;
  kind: string;
  expected_amount_clp: number;
  link: RealEstateExpenseLinkDto | null;
  display_amount_clp: number;
  note: string | null;
  can_link: boolean;
}

export interface RealEstateExpenseAccountBlock {
  account_slug: ExpenseApartmentSlug;
  label: string;
  slots: RealEstateBillSlot[];
  total_clp: number;
}

/** `GET /api/flows/expenses/real-estate` — bill slots linked to gastos purchases. */
export interface RealEstateExpensesResponse {
  slots: RealEstateBillSlot[];
  by_account: Record<ExpenseApartmentSlug, RealEstateExpenseAccountBlock>;
  chart_monthly: FlowExpenseChartPoint[];
  chart_yearly: FlowExpenseChartPoint[];
  total_clp: number;
}

export interface RealEstateLinkCandidateDto {
  purchase_key: string;
  merchant: string | null;
  purchase_on: string | null;
  amount_clp: number;
  origin_label: string;
  source: FlowCcExpenseLineSource;
  merchant_matches: boolean;
  /** Months from bill month (0 = same month, 1–2 = later card payment). */
  purchase_month_offset: number;
}

export type SyncSourceId =
  | "afp_uno"
  | "fintual"
  | "fintual_rn_composition"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "stocks_nyse"
  | "yahoo_fx_usd"
  | "crypto_eod";

export type SyncSourceDisplayStatus = "ok" | "stale" | "disabled";

export type SyncSourceDayKind = "open" | "weekend" | "holiday";

export interface SyncSourceWallTime {
  ymd: string;
  hour: number;
  minute: number;
  timeZone: "America/Santiago" | "America/New_York";
}

export interface SyncSourceStatusRow {
  source: SyncSourceId;
  status: SyncSourceDisplayStatus;
  stale: boolean;
  next_sync: SyncSourceWallTime | null;
  next_sync_imminent: boolean;
  today_day_kind: SyncSourceDayKind;
}

export interface SyncSchedulerStatus {
  enabled: boolean;
  interval_ms: number;
  in_flight: boolean;
  next_check_at: string | null;
}

export type ImportSyncDocumentKind =
  | "checking_cartola"
  | "cuenta_vista_cartola"
  | "cc_statement";

export type CcStatementCoverageCurrency = "clp" | "usd";

export interface ImportSyncDocumentAccount {
  account_id: number;
  label: string;
  document_kind: ImportSyncDocumentKind;
  /** CLP/USD column when this card has at least one USD PDF statement. */
  cc_statement_currency?: CcStatementCoverageCurrency;
}

export interface ImportSyncDocumentCell {
  imported: boolean;
  /** Absolute local path to the source PDF/XLSX when present on disk. */
  file_path: string | null;
  /** PDF text includes `** CARTOLA SIN MOVIMIENTOS **`. */
  file_sin_movimientos?: boolean;
}

/** `GET /api/import-sync/document-coverage` */
export interface ImportSyncDocumentCoverageResponse {
  months: string[];
  accounts: ImportSyncDocumentAccount[];
  cells: ImportSyncDocumentCell[][];
}

export interface CcExpenseGenericUniqueMerchantRow {
  id: number;
  merchant_key: string;
  sort_order: number;
}

/** `GET /api/import-sync/generic-unique-merchants` */
export interface GenericUniqueMerchantsResponse {
  merchants: CcExpenseGenericUniqueMerchantRow[];
}

/** `POST|PATCH /api/import-sync/generic-unique-merchants` */
export interface GenericUniqueMerchantMutationResponse {
  row: CcExpenseGenericUniqueMerchantRow;
  backfill: { inserted: number; merchant_rules_removed: number };
}

/** `GET /api/sync/status` */
export interface SyncStatusResponse {
  chile: { ymd: string; hour: number; minute: number; monthKey: string };
  stale: SyncSourceId[];
  sources: SyncSourceStatusRow[];
  scheduler: SyncSchedulerStatus;
  /** ISO-ish timestamp from latest sync log row (`app_messages`, kind=log). */
  last_sync_at: string | null;
}

/** `GET /api/flows/deposits` — amounts may be negative (withdrawals). */
export interface FlowsDepositsResponse {
  rows: FlowDepositRow[];
  chart_monthly: FlowDepositChartPoint[];
  chart_yearly: FlowDepositChartPoint[];
  /** Sum of all row amounts (matches dashboard “Total deposits”). */
  net_total_clp: number;
  net_total_usd: number | null;
  fx_conversion_error?: boolean;
  fx_conversion_warnings?: FxConversionWarning[];
  chart_monthly_usd: FlowDepositChartPoint[];
  chart_yearly_usd: FlowDepositChartPoint[];
  by_category: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number | null }
  >;
}

/** One leg of a historical mirror pair (panel /panel/mirror-pairs). */
export interface MirrorLegDto {
  movement_id: number;
  account_id: number;
  account_name: string;
  kind_slug: string | null;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
}

export interface MirrorPairCandidate {
  out: MirrorLegDto;
  in: MirrorLegDto;
  gap_days: number;
  within_business_day_window: boolean;
  /** One leg is month-precision (cuenta de ahorro): dates are conventional month-ends. */
  month_precision: boolean;
  month_straddle: boolean;
  /** Pair comes from an existing expense_deposit_links row (gastos match), not the heuristic. */
  linked: boolean;
  out_candidate_count: number;
  in_candidate_count: number;
  confidence: "high" | "ambiguous";
  blocked: boolean;
  blocked_reason: "checking_inflow_month_straddle" | null;
}

export interface RejectedMirrorPair {
  out: MirrorLegDto;
  in: MirrorLegDto;
  created_at: string;
}

export interface MovementMirrorCandidatesResponse {
  pairs: MirrorPairCandidate[];
  rejected: RejectedMirrorPair[];
}

export interface MirrorPairRef {
  out_movement_id: number;
  in_movement_id: number;
}

/** Adjustable inputs for /projections (CLP amounts are today's money). */
export interface ProjectionParams {
  real_return_pct: number;
  monthly_aporte_clp: number;
  inflation_clp_pct: number;
  inflation_usd_pct: number;
  retire_return_pct: number;
  end_age: number;
  swr_pct: number;
  pct_balance_pct: number;
  monthly_income_clp: number;
  /** % of the non-invested remainder (RE, cash) liquidated into the drawdown pot at 65. */
  liquidate_other_pct: number;
  /** Passive real monthly income during retirement (rent), today's CLP. */
  monthly_rent_clp: number;
}

export interface ProjectionsResponse {
  unit: "clp" | "usd";
  fx_clp_per_usd: number;
  params: ProjectionParams;
  retire_month: string;
  retire_age: number;
  summary: {
    /** The drawdown base at retirement (invested or total per `drawdown_base`). */
    balance_at_retire: number;
    invested_at_retire: number;
    total_at_retire: number;
    monthly_rent: number;
    swr_monthly_income: number;
    pct_balance_initial_monthly_income: number;
    fixed_monthly_income: number;
    swr_depletion_age: number | null;
    fixed_income_depletion_age: number | null;
  };
  chart: {
    points: Record<string, string | number | null>[];
    lines: { dataKey: string; name: string; valueSeriesType: "data" | "reference" }[];
  };
}
