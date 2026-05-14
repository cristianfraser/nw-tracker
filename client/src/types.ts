export type AssetGroupSlug =
  | "retirement"
  | "brokerage"
  | "cash_eqs"
  | "crypto"
  | "real_estate"
  | "liabilities";

export interface CategoryRow {
  id: number;
  group_id: number;
  slug: string;
  label: string;
  sort_order: number;
}

export interface AssetGroupRow {
  id: number;
  slug: string;
  label: string;
  sort_order: number;
  categories: CategoryRow[];
}

export interface AssetTreeResponse {
  groups: AssetGroupRow[];
}

export interface AccountListRow {
  id: number;
  name: string;
  notes: string | null;
  created_at: string;
  category_slug: string;
  category_label: string;
  group_slug: string;
  group_label: string;
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
  group_slug: string;
  group_label: string;
  category_slug: string;
  category_label: string;
  deposits_clp: number;
  current_value_clp: number | null;
  valuation_as_of: string | null;
  current_value_usd?: number | null;
  fx_clp_per_usd?: number | null;
  fx_date_used?: string | null;
  position?: AccountPositionSnapshot | null;
}

export interface DashboardResponse {
  totals: {
    net_worth_clp: number;
    deposits_clp: number;
    real_estate_clp: number;
    retirement_clp: number;
    brokerage_clp: number;
    cash_eqs_clp: number;
    crypto_clp: number;
    liabilities_clp: number;
    net_worth_usd?: number | null;
    real_estate_usd?: number;
    retirement_usd?: number;
    brokerage_usd?: number;
    cash_eqs_usd?: number;
    crypto_usd?: number;
    liabilities_usd?: number;
  };
  allocation: {
    group_slug: string;
    group_label: string;
    value_clp: number;
    value_usd?: number;
  }[];
  accounts: DashboardAccountRow[];
}

export interface FxLatest {
  date: string;
  clp_per_usd: number;
}

export interface UfLatest {
  date: string;
  clp_per_uf: number;
}

export interface TimeseriesAccountLine {
  account_id: number;
  name: string;
  dataKey: string;
  /** Cumulative deposits (CLP) through each date, same unit as valuations; thinner line in UI */
  depositDataKey?: string;
  /** Legend label for the deposit line when not the default "aportes acum." */
  deposit_series_name?: string;
}

export interface TimeseriesBlock {
  accounts?: TimeseriesAccountLine[];
  lines?: { dataKey: string; name: string }[];
  points: Record<string, string | number | null>[];
}

/** Dashboard home, or `/api/...?group=` for class tabs */
export interface ValuationTimeseriesResponse {
  unit: "clp" | "usd" | "uf";
  accounts_ex_property?: TimeseriesBlock;
  overview?: Required<Pick<TimeseriesBlock, "lines" | "points">>;
  group_slug?: string;
  /** Whole class tab: all accounts on one line chart (+ deposit lines) */
  accounts_in_group?: TimeseriesBlock;
  group_allocation_pie?: { name: string; account_id: number; value: number }[];
}

/** `GET /api/accounts/:id/deposit-inflows` — same merge as charts / summary deposits */
export interface AccountDepositInflowsResponse {
  account_id: number;
  total_clp: number;
  events: { occurred_on: string; amt_clp: number; cumulative_clp: number }[];
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

export interface AccountMortgageLedgerResponse {
  account_id: number;
  source: "csv" | "none";
  meta: AccountMortgageLedgerMeta | null;
  rows: DeptoMortgageSheetRow[];
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
  /** Sum units added in the month (brokerage_flows.units_delta > 0): buys + DRIP. */
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
  unit: "clp" | "usd" | "uf";
}

export interface AccountMonthlyPerformanceResponse {
  account_id: number;
  category_slug: string;
  monthly: AccountMonthlyPerformanceRow[];
}

/** `GET /api/groups/:slug/performance-monthly` — derived, not stored. */
export interface GroupMonthlyPerformanceBarAccount {
  account_id: number;
  name: string;
  bar_data_key: string;
}

export interface GroupMonthlyPerformanceResponse {
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
}

/** `GET /api/dashboard/stocks-earnings-monthly` — merged SPY+VEA (or single), derived. */
export interface StocksLifetimeEarningsResponse {
  unit: "clp" | "usd" | "uf";
  stock_accounts: { account_id: number; name: string }[];
  points: { as_of_date: string; delta_month: number; accumulated_earnings: number; ytd_merged: number }[];
}

/** `GET /api/market-series` — FX, UF, `equity_daily` (USD EOD per ticker), `fund_unit_daily` (valor cuota CLP); CLP crosses derived from carried-forward FX. */
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
