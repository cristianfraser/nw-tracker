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
  /** Day window = (prior completed NYSE session, Chile today]; null for CC/mortgage rows. */
  deposits_day_clp?: number;
  deposits_day_usd?: number | null;
  delta_day_clp?: number | null;
  delta_day_usd?: number | null;
  prior_day_close_clp?: number | null;
  prior_day_close_usd?: number | null;
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
  /** Prior completed NYSE session (day window anchor). */
  day_end?: string | null;
  month: DashboardBucketCloseTotals;
  year: DashboardBucketCloseTotals;
  day?: DashboardBucketCloseTotals;
}

/** One period slice of server-computed nav card metrics (mirror of CardGroupMetrics). */
export interface NavCardPeriodMetricsDto {
  deposits_clp: number;
  deposits_usd: number | null;
  delta_total_clp: number | null;
  delta_total_usd: number | null;
  deposits_period_clp: number;
  deposits_period_usd: number | null;
  delta_period_clp: number | null;
  delta_period_usd: number | null;
}

export interface NavCardMetricsVariantDto {
  day: NavCardPeriodMetricsDto;
  month: NavCardPeriodMetricsDto;
  year: NavCardPeriodMetricsDto;
  title_delta: {
    month_clp: number | null;
    month_usd: number | null;
    year_clp: number | null;
    year_usd: number | null;
    day_clp: number | null;
    day_usd: number | null;
  };
}

/**
 * Server-computed card metrics per nav-tree group slug (server/src/dashboardNavCardMetrics.ts).
 * `child` = the node as a strip detail card; `parent` = the node as its page's compact card.
 * The client renders these — it never re-sums account rows for group cards.
 */
export interface NavCardMetricsDto {
  child: NavCardMetricsVariantDto;
  parent: NavCardMetricsVariantDto;
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
  /** Server-computed nav card metrics keyed by portfolio-group slug. */
  card_metrics_by_slug: Record<string, NavCardMetricsDto>;
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

/**
 * Server-sent overview chart line label keys without a bucket-card counterpart. The literal
 * union registers them for i18n/keyIntegrity.test.ts (same role as SERVER_NAV_LABEL_I18N_KEYS).
 * (Liabilities/net-worth/bucket lines reuse their dashboard.* card keys.)
 */
export type OverviewChartLineI18nKey = "charts.overview.invested";

export interface TimeseriesAccountLine {
  account_id: number;
  name: string;
  /** i18n key for server-grouped bucket lines; client resolves at render (falls back to `name`). */
  name_i18n_key?: string | null;
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

/** Allocation-pie slice; `name_i18n_key` set for server-grouped bucket slices. */
export interface GroupAllocationPieSlice {
  name: string;
  account_id: number;
  value: number;
  name_i18n_key?: string | null;
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
  group_allocation_pie?: GroupAllocationPieSlice[];
  /** Server-side "Agrupado" bucket blocks (built pre-clip; totals identical to accounts_in_group). */
  nav_grouped_blocks?: { grouped?: TimeseriesBlock; ungrouped?: TimeseriesBlock };
  nav_grouped_pie?: { grouped?: GroupAllocationPieSlice[]; ungrouped?: GroupAllocationPieSlice[] };
  /** Pasivos grouped bucket block/pie (single mode — no Agrupado toggle). */
  liab_grouped_block?: TimeseriesBlock;
  liab_grouped_pie?: GroupAllocationPieSlice[];
}

/** One NYSE-session point of `GET /api/dashboard/overview-daily` (values in the request unit). */
export interface DashboardOverviewDailyPoint {
  as_of_date: string;
  net_worth: number | null;
  real_estate: number | null;
  retirement: number | null;
  brokerage: number | null;
  cash_eqs: number | null;
}

/** Daily net-worth series for the day period view (grid = NYSE sessions, "vs last workday"). */
export interface DashboardOverviewDailyResponse {
  unit: "clp" | "usd";
  days: number;
  end_ymd: string;
  /** True while the NYSE regular session is open (the last point tracks live marks). */
  d1_is_live: boolean;
  points: DashboardOverviewDailyPoint[];
}

/** One session row of `GET /api/daily-series` (unit-converted; nulls = missing legs). */
export interface DailySeriesPointDto {
  as_of_date: string;
  value: number | null;
  flow: number;
  delta: number | null;
  pl: number | null;
  pct: number | null;
  /** False on weekends/shared holidays — the detalle table dims those rows. */
  market_day?: boolean;
}

export interface DailySeriesAccountLineDto {
  account_id: number;
  name: string | null;
  /** Per-session values, index-aligned with `points`. */
  values: (number | null)[];
  /** Cumulative personal deposits through each session (aportes acum. companion line). */
  deposits_acum?: number[];
}

/** Daily series for a group page or account (grid = NYSE sessions, "vs last workday"). */
export interface DailySeriesResponse {
  unit: string;
  end_ymd: string;
  d1_is_live: boolean;
  baseline: { as_of_date: string; value: number | null };
  points: DailySeriesPointDto[];
  accounts?: DailySeriesAccountLineDto[];
  /** Σ of account `deposits_acum` per session (`__group_dep_total` line). */
  deposits_acum_total?: number[];
  /** Agrupado lines (bucket sums keyed by the monthly grouped block's synthetic ids). */
  grouped_accounts?: DailySeriesAccountLineDto[];
}
