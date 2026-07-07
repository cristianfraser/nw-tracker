import type { AccountPositionSnapshot, FxConversionWarning } from "./core";
import type { DepositFlowCategory, FlowDepositRow } from "./flows";

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
