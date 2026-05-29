import type { MovementCreateSchema } from "./accountMovementCreate";

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
}

export interface AssetTreeCategoryRow {
  id: number;
  group_id: number;
  slug: string;
  label: string;
  sort_order: number;
}

export interface AssetTreeAccountRow {
  id: number;
  name: string;
  notes: string | null;
}

export interface AssetTreeGroupRow {
  id: number;
  slug: string;
  label: string;
  sort_order: number;
  color_rgb?: string | null;
  parent_id?: number | null;
  is_leaf?: boolean;
  children?: AssetTreeGroupRow[];
  accounts?: AssetTreeAccountRow[];
  /** @deprecated legacy category rows; empty on nested bucket tree */
  categories?: AssetTreeCategoryRow[];
}

export interface AssetTreeResponse {
  groups: AssetTreeGroupRow[];
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
  category_slug: string;
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
  position?: AccountPositionSnapshot | null;
  /** True when monthly closes show a long zero tail (same rule as chart tail clip). From `/api/dashboard`. */
  chart_inactive?: boolean;
  /** When 1, listed in nav/charts but omitted from bucket totals, class Total, NW cash bucket. */
  exclude_from_group_totals?: number;
}

export interface DashboardLayoutCardRow {
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  bucket_slug: string;
  card_css: string | null;
  route_path?: string | null;
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
    net_worth_usd?: number | null;
    deposits_usd?: number;
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
  /** Suecia depto snapshot for dashboard RE card (valor / net / mortgage). */
  suecia_snapshot?: {
    valor_clp: number;
    net_value_clp: number;
    mortgage_clp: number;
    valor_usd?: number | null;
    net_value_usd?: number | null;
    mortgage_usd?: number | null;
  } | null;
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
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number }
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
  csv_path: string;
  csv_absolute_path?: string;
  csv_file_exists?: boolean;
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
  source: "csv" | "none";
  meta: AccountMortgageLedgerMeta | null;
  rows: DeptoMortgageSheetRow[];
  payment_scenarios?: DeptoPaymentScenarioRow[];
}

/** `GET /api/accounts/:id/cc-installments` — credit_card: installment purchases from CSV + monthly projection. */
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
}

export interface CreditCardBillingConfigDto {
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
}

export interface CcInstallmentPurchaseComputed {
  purchase_id: string;
  purchase_db_id?: number;
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
}

export interface CcInstallmentMonthBreakdown {
  purchase_id: string;
  label: string;
  installment_index: number;
  amount_clp: number;
}

export interface CcInstallmentMonthRow {
  month: string;
  total_clp: number;
  breakdown: CcInstallmentMonthBreakdown[];
}

export interface AccountCcInstallmentsMeta {
  csv_path: string;
  csv_absolute_path: string;
  csv_file_exists: boolean;
  db_purchase_count?: number;
  db_payment_count?: number;
  pay_by_rule?: string;
  remaining_balance_line_rule?: string;
}

export interface CcInstallmentHistoryMonthPoint {
  month: string;
  remaining_balance_clp: number;
  installment_payments_clp: number;
  /** PDF ledger only (sin sustituir por valorización); solo cuando `source === "db"`. */
  ledger_remaining_installments_clp?: number;
}

export interface AccountCcInstallmentsResponse {
  account_id: number;
  source: "csv" | "db" | "none";
  meta: AccountCcInstallmentsMeta | null;
  purchases: CcInstallmentPurchaseComputed[];
  /** Compras en cuotas ya liquidadas (restan 0 y saldo 0). */
  purchases_completed: CcInstallmentPurchaseComputed[];
  months: CcInstallmentMonthRow[];
  totals: {
    total_remaining_principal_clp: number;
    next_calendar_month_total_clp: number | null;
    next_calendar_month: string | null;
  };
  /** Present for `source === "db"`: end-of-month outstanding installment principal vs cuotas pagadas en ese mes. */
  installment_history_months?: CcInstallmentHistoryMonthPoint[];
  statements?: CcStatementDto[];
  billing_month_balances?: CcBillingMonthBalanceDto[];
  billing_detail_by_month?: CcBillingDetailMonthDto[];
  facturaciones?: CcFacturacionDto[];
  billing_config?: CreditCardBillingConfigDto;
  /** Open facturación month for manual / web-paste (`YYYY-MM`). */
  open_billing_month?: string | null;
}

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

/** `GET /api/accounts/:id/summary` */
export interface AccountSummaryResponse {
  account_id: number;
  category_slug: string | null;
  group_slug: string | null;
  group_label: string | null;
  group_peer_count: number | null;
  deposits_clp: number;
  withdrawals_clp: number;
  latest_valuation_clp: number | null;
  latest_valuation_date: string | null;
  position: AccountPositionSnapshot | null;
  movement_create?: MovementCreateSchema;
}

/** `GET /api/accounts/:id/detail-bundle` */
export interface AccountDetailBundleResponse {
  summary: AccountSummaryResponse;
  movements: {
    id: number;
    amount_clp: number;
    occurred_on: string;
    note: string | null;
    units_delta: number | null;
    flow_kind: string | null;
    amount_usd: number | null;
    ticker: string | null;
    flow_type: string;
    flow_type_label: string;
  }[];
  ts: AccountValuationTimeseriesResponse | null;
  depositInflows: AccountDepositInflowsResponse;
  mortgageLedger: AccountMortgageLedgerResponse;
  ccLedger: AccountCcInstallmentsResponse;
  invNavAccounts: { accounts: AccountListRow[] };
  checkingCartolaMonths: CheckingCartolaMonthsResponse | null;
  monthly_performance: AccountMonthlyPerformanceResponse | null;
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
  movement_count: number;
  imported_at: string | null;
}

export interface CheckingCartolaMonthsResponse {
  account_id: number;
  imported_months: string[];
  rows: CheckingCartolaMonthRowDto[];
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

/** `GET /api/dashboard/nav-context` — nav strip + overview in one response. */
export interface DashboardNavContextResponse {
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  cash_credit_card_links: DashboardResponse["cash_credit_card_links"];
  overview: ValuationTimeseriesResponse["overview"];
}

/** `GET /api/dashboard/page-bundle` — home dashboard in one response. */
export interface DashboardPageBundleResponse {
  dash: DashboardResponse;
  ts: ValuationTimeseriesResponse;
  fx: FxLatest | null;
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
    category_slug: string;
    monthly: AccountMonthlyPerformanceRow[];
  }[];
  consolidated_monthly: ConsolidatedMonthlyPerfRow[];
  account_movements: {
    account_id: number;
    name: string;
    category_slug: string;
    movements: AccountDetailBundleResponse["movements"];
  }[];
}

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
}

/** `GET /api/market-ticker` — Chile-today snapshot for the marquee (not forward-filled series tail). */
export interface MarketDisplaySeriesRow {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: "equity" | "fund_unit" | "fx_usd" | "uf";
  series_key: string | null;
  show_in_marquee: number;
  show_in_rates: number;
  rates_chart_title: string | null;
}

export interface MarketTickerResponse {
  chile_today: string;
  uf: { date: string; clp_per_uf: number } | null;
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  risky_norris: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  equities: {
    ticker: string;
    trade_date: string;
    value_usd: number;
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
  api_group: string | null;
  api_subgroup: string | null;
  color_rgb: string | null;
  color: string | null;
  /** `nav_hub` = routing only (e.g. inversiones); balances use child asset groups. */
  group_kind: "normal" | "reference" | "nav_hub";
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

export type ExpenseFlowGroupSlug = "real_estate";

export type ExpenseApartmentSlug = "el_vergel" | "lastarria" | "suecia";

export interface FlowExpenseRow {
  spent_on: string;
  group_slug: ExpenseFlowGroupSlug;
  group_label: string;
  account_id: number;
  account_slug: ExpenseApartmentSlug;
  account_name: string;
  amount_clp: number;
  category: string | null;
  note: string | null;
}

export interface FlowExpenseChartPoint {
  as_of_date: string;
  real_estate: number;
  lastarria: number;
  suecia: number;
  el_vergel: number;
  total: number;
}

export interface FlowExpenseAccountBlock {
  account_id: number;
  account_slug: ExpenseApartmentSlug;
  label: string;
  rows: FlowExpenseRow[];
  total_clp: number;
}

export interface FlowExpenseGroupBlock {
  label: string;
  total_clp: number;
  by_account: Record<string, FlowExpenseAccountBlock>;
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

export type FlowCcExpenseLineSource = "cc" | "checking";

export interface FlowCcExpenseLineRow {
  source: FlowCcExpenseLineSource;
  statement_line_id: number;
  account_id: number;
  /** Calendar month bucket (YYYY-MM). */
  expense_month: string;
  /** Facturación month (CC); same as expense_month for checking. */
  billing_month: string;
  /** Calendar month of purchase (YYYY-MM). */
  purchase_month: string;
  line_role: "purchase" | "installment_cuota" | "installment_purchase_total";
  occurred_on: string;
  purchase_on: string | null;
  statement_date: string;
  amount_clp: number;
  /** Original USD when the charge is on a USD statement (or USD-only line). */
  amount_usd?: number | null;
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
  /** Card last4 (CC) or full account name (checking). */
  origin_label: string;
}

export type FlowCcExpenseCategoryChartPoint = {
  as_of_date: string;
  [categorySlug: string]: string | number;
};

/** `GET /api/flows/expenses/credit-card` — Pasivos tarjeta de crédito (grupo, líneas de estado de cuenta). */
export interface FlowsCreditCardExpensesResponse {
  group_slug: string;
  account_ids: number[];
  categories: CcExpenseCategoryDto[];
  lines: FlowCcExpenseLineRow[];
  by_month: FlowCcExpenseMonthRow[];
  chart_monthly: FlowCcExpenseChartPoint[];
  chart_monthly_by_category: FlowCcExpenseCategoryChartPoint[];
  total_clp: number;
  total_real_clp: number;
}

/** `GET /api/flows/expenses` — apartment utility / housing costs (positive outflows). */
export interface FlowsExpensesResponse {
  rows: FlowExpenseRow[];
  chart_monthly: FlowExpenseChartPoint[];
  chart_yearly: FlowExpenseChartPoint[];
  total_clp: number;
  by_group: Record<ExpenseFlowGroupSlug, FlowExpenseGroupBlock>;
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
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "stocks_nyse"
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
}

/** `GET /api/import-sync/document-coverage` */
export interface ImportSyncDocumentCoverageResponse {
  months: string[];
  accounts: ImportSyncDocumentAccount[];
  cells: ImportSyncDocumentCell[][];
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
  net_total_usd: number;
  chart_monthly_usd: FlowDepositChartPoint[];
  chart_yearly_usd: FlowDepositChartPoint[];
  by_category: Record<
    DepositFlowCategory,
    { label: string; rows: FlowDepositRow[]; total_clp: number; total_usd: number }
  >;
}
