import type { AccountPositionSnapshot, FxConversionWarning } from "./core";
import type { CcFacturadoBarSegments } from "./creditCard";
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
  /** Flow-adjusted period returns (server-computed ratios; total = P/L ÷ lifetime deposits). */
  pct_day_clp?: number | null;
  pct_month_clp?: number | null;
  pct_year_clp?: number | null;
  pct_total_clp?: number | null;
  pct_day_usd?: number | null;
  pct_month_usd?: number | null;
  pct_year_usd?: number | null;
  pct_total_usd?: number | null;
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
}

/** A balance in both units (usd null = no member carries a dollar value in this payload). */
export interface NavCardAmountDto {
  clp: number;
  usd: number | null;
}

/** Mirror of server `NavCardValueDto`: a nav node's balances, picked, never re-summed. */
export interface NavCardValueDto {
  /** The detail card's balance (a cash child: the CC-netted cash bucket). */
  child: NavCardAmountDto;
  /** The node's own page summary card and accounts-table «Total» row. */
  parent: NavCardAmountDto;
  /** Σ of the member rows the card covers, never netted (a card breakdown line). */
  members: NavCardAmountDto;
  fx_missing: boolean;
  sync_stale: boolean;
}

/**
 * Server-computed card figures per nav-tree group slug (server/src/dashboardNavCardMetrics.ts).
 * `child` = the node as a strip detail card; `parent` = the node as its page's compact card.
 * The client renders these — it never re-sums account rows for a group's balance or metrics.
 */
export interface NavCardMetricsDto {
  value: NavCardValueDto;
  child: NavCardMetricsVariantDto;
  parent: NavCardMetricsVariantDto;
  /**
   * The node's flow-adjusted return as one row of its parent's accounts table (a bucket
   * listed beside accounts — Portafolio IPSA among Acciones' stocks), per period and unit.
   */
  row_pct: Record<"day" | "month" | "year" | "total", { clp: number | null; usd: number | null }>;
  /** The node's own return over the `parent` scope — its page's «Total» row. */
  parent_pct: Record<"day" | "month" | "year" | "total", { clp: number | null; usd: number | null }>;
  /** The liquidated rows of the node's accounts table, grouped as one row (absent: none). */
  liquidated?: NavLiquidatedRowsDto;
}

/** Mirror of server `NavLiquidatedRowsDto`. */
export interface NavLiquidatedRowsDto {
  /** Chart-inactive member accounts listed on their own. */
  account_ids: number[];
  /** Chart-inactive sub-buckets listed beside the node's accounts. */
  group_slugs: string[];
  metrics: NavCardMetricsVariantDto;
  /** Σ balance over the same rows. */
  value: NavCardAmountDto & { fx_missing: boolean };
  row_pct: Record<"day" | "month" | "year" | "total", { clp: number | null; usd: number | null }>;
}

/** One tile / frame of the server-built value map (`value_map`). Mirror of server `NavValueMapNodeDto`. */
/** The ETF behind a holding tile of a proxied fund (mirror of server `NavValueMapHoldingDto`). */
export interface NavValueMapHoldingDto {
  ticker: string;
  /** Share of the whole fund. */
  weight: number;
  /** The holding's share of the fund's period return, fraction of the fund, per unit. */
  contribution_pct: Record<"day" | "month" | "year", { clp: number | null; usd: number | null }>;
  /** Calendar days in the period the fund held it, out of the period's days so far. */
  days_held: Record<"day" | "month" | "year", { held: number; total: number }>;
}

export interface NavValueMapNodeDto {
  kind: "group" | "account" | "holding";
  /** Group slug, `account_<id>` for an account tile, `holding_<bucket>_<ticker|other>` for a holding tile. */
  slug: string;
  account_id: number | null;
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  value_clp: number;
  value_usd: number | null;
  pct: Record<"day" | "month" | "year", { clp: number | null; usd: number | null }>;
  pl: Record<"day" | "month" | "year", { clp: number | null; usd: number | null }>;
  /** The nav group has group children (a frame). False for tiles. */
  frame: boolean;
  children?: NavValueMapNodeDto[];
  /** Leaf groups: their accounts (> 0); the page opens its first-level leaves into them. */
  leaf_accounts?: NavValueMapNodeDto[];
  /** Holding tiles only: the ETF behind the tile; null on the «Otros» (non-ETF sleeve) tile. */
  holding?: NavValueMapHoldingDto | null;
}

/** Full colour at ±bound (fractions), fixed per period by the server. */
export type NavValueMapColorBounds = Record<"day" | "month" | "year", number>;

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
  /** Net-worth value map (treemap) tree and its fixed colour bounds. */
  value_map?: NavValueMapNodeDto;
  value_map_color_bounds?: NavValueMapColorBounds;
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
  /**
   * Retiro and brokerage net deposits per month, by class (flows chart aggregation); the yearly
   * combos roll them up after their Rango cut.
   */
  inversiones_deposits_chart?: {
    monthly_clp: InversionesDepositsPoint[];
    monthly_usd?: InversionesDepositsPoint[];
  };
  /** Home bucket cards (order + bucket) from `portfolio_groups`; Patrimonio neto hero is not included. */
  dashboard_layout?: DashboardLayoutCardRow[];
  /** True when deposit USD totals could not be converted (missing fx_daily). */
  fx_conversion_error?: boolean;
  fx_conversion_warnings?: FxConversionWarning[];
}

/** One period's net deposits into the two invested classes (display unit). */
export interface InversionesDepositsPoint {
  as_of_date: string;
  retirement: number;
  brokerage: number;
}

export interface FxLatest {
  date: string;
  clp_per_usd: number;
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

/** One member of a server-built composition-share block (values 0..1, aligned to `dates`). */
export interface ProportionalSeriesLineDto {
  dataKey: string;
  name: string;
  name_i18n_key?: string | null;
  color_rgb?: string | null;
  /** Member identity for client color maps (same key the old pie sliceFill used). */
  account_id?: number;
  values: (number | null)[];
}

/** Composition timeseries (pie replacement): per-date shares summing to 1 where a base exists. */
export interface ProportionalSeriesBlockDto {
  dates: string[];
  series: ProportionalSeriesLineDto[];
}

/** All-time high of a net-worth line at one grain: the peak point's date and value in the payload unit. */
export interface NetWorthAthDto {
  as_of_date: string;
  value: number;
}

/** One peak per chart grain, each over the series that grain plots (see server `netWorthAllTimeHigh.ts`). */
export interface NetWorthAthByPeriod {
  /** Full-history daily walk (Diario). */
  day: NetWorthAthDto | null;
  /** Latest-dated overview point of each calendar month (Mensual). */
  month: NetWorthAthDto | null;
  /** Latest-dated overview point of each calendar year (Anual). */
  year: NetWorthAthDto | null;
}

export interface TimeseriesBlock {
  accounts?: TimeseriesAccountLine[];
  lines?: {
    dataKey: string;
    name: string;
    valueSeriesType: ValueSeriesType;
    /** Resolved from `portfolio_groups` for dashboard overview buckets. */
    color_rgb?: string;
    /** A reference level fixed in a currency (the USD milestones): in that display unit its value
     * is its own name, so the tooltip leaves it out. */
    level_currency?: "clp" | "usd";
  }[];
  points: Record<string, string | number | null>[];
  /** Server: portfolio group color (or resolver fallback) for synthetic aggregated lines; keys like `"-203"`. */
  synthetic_group_color_rgb?: Record<string, string>;
  /** USD milestone levels (in the block's unit) for chart anchor dates (month/year prior period ends). */
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
  /** Home: also carries the USD milestone reference lines (`usd_50k`, …) and their anchors. */
  overview?: Required<Pick<TimeseriesBlock, "lines" | "points">> &
    Pick<TimeseriesBlock, "referenceMilestoneByDate"> & {
    /** Per-grain peaks of the net-worth line (this unit); absent on placeholder / keep-prev bundles. */
    ath?: NetWorthAthByPeriod | null;
  };
  group_slug?: string;
  /** Whole class tab: all accounts on one line chart (+ deposit lines) */
  accounts_in_group?: TimeseriesBlock;
  group_allocation_proportional?: ProportionalSeriesBlockDto;
  /** Home: asset-bucket composition shares (pie replacement). */
  allocation_proportional?: ProportionalSeriesBlockDto;
  /** Server-side "Agrupado" bucket blocks (built pre-clip; totals identical to accounts_in_group). */
  nav_grouped_blocks?: { grouped?: TimeseriesBlock; ungrouped?: TimeseriesBlock };
  nav_grouped_proportional?: ProportionalSeriesBlockDto;
  /** Pasivos grouped bucket block + shares (single mode — no Agrupado toggle). */
  liab_grouped_block?: TimeseriesBlock;
  liab_grouped_proportional?: ProportionalSeriesBlockDto;
  /** Pasivos: each reference line («Disponible», «Disponible total») ÷ the mortgage balance (fraction). */
  reference_coverage?: ProportionalSeriesBlockDto;
}

/** One NYSE-session point of `GET /api/dashboard/overview-daily` (values in the request unit). */
export interface DashboardOverviewDailyPoint {
  invested: number | null;
  liabilities: number | null;
  as_of_date: string;
  net_worth: number | null;
  real_estate: number | null;
  retirement: number | null;
  brokerage: number | null;
  cash_eqs: number | null;
  /** USD milestone reference levels (`usd_50k`, …) in the request unit, same keys as the
   * monthly overview's reference lines. */
  [usdMilestoneKey: `usd_${string}`]: number | null;
}

/** A «Cuentas principales» child line: values in the request unit, aligned to `points`,
 * keyed by the same synthetic dataKey as the monthly `accounts_ex_property` accounts. */
export interface PrimaryDailyLine {
  dataKey: string;
  values: (number | null)[];
}

/** Daily net-worth series for the day period view (calendar-day grid, last point live). */
export interface DashboardOverviewDailyResponse {
  unit: "clp" | "usd";
  days: number;
  end_ymd: string;
  points: DashboardOverviewDailyPoint[];
  /** «Cuentas principales» per-child-group daily lines (request unit). */
  primary_lines: PrimaryDailyLine[];
  /** Home composition shares at day grain (same dataKeys as the monthly block). */
  allocation_proportional?: ProportionalSeriesBlockDto;
  /** Peak of the net-worth line (full-history daily walk, this unit); null when no day is finite. */
  ath: NetWorthAthDto | null;
}

/** One calendar-day row of `GET /api/daily-series` (unit-converted; nulls = missing legs). */
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
  /** Per-day values, index-aligned with `points`. */
  values: (number | null)[];
  /** Cumulative personal deposits through each day (aportes acum. companion line). Null past the
   * value line's trailing clip — a sold-out account's aportes end with its value line. */
  deposits_acum?: (number | null)[];
  /**
   * Per-day flow-adjusted P/L for this account alone — the day-grain twin of the monthly
   * `pl_<account_id>` bars. Σ over the lines equals the bucket point's `pl`.
   */
  pl?: (number | null)[];
}

/** Daily series for a group page or account (calendar-day grid, last point live). */
export interface DailySeriesResponse {
  unit: string;
  end_ymd: string;
  baseline: { as_of_date: string; value: number | null };
  points: DailySeriesPointDto[];
  accounts?: DailySeriesAccountLineDto[];
  /** Composition shares at day grain (per account; pie replacement). */
  proportional?: ProportionalSeriesBlockDto;
  /** Composition shares of the grouped bucket lines (when the page has bucket nodes). */
  grouped_proportional?: ProportionalSeriesBlockDto;
  /** Pasivos: the day-grain twin of the monthly `reference_coverage`. */
  reference_coverage?: ProportionalSeriesBlockDto;
  /**
   * CC scopes only (a card's own page, or a Pasivos / credit-card group page — summed over the
   * masters its merged monthly ledger sums; CLP requests only): per-day owed («saldo total»,
   * CLP), index-aligned with points.
   */
  cc_owed?: (number | null)[];
  /** CC scopes only: per-day plan debt («deuda en cuotas», CLP), index-aligned with points. */
  cc_installment_debt?: (number | null)[];
  /**
   * CC scopes only: future daily tail of the installment simulation (`today+1 .. plan end`, CLP),
   * so the daily historial covers the same window as its monthly/yearly forms.
   */
  cc_plan_tail?: { as_of_date: string; plan_debt_clp: number; balance_clp: number }[];
  /**
   * CC scopes only: one facturación bar per billing month (Σ of the members' bars, as the monthly
   * chart stacks them) on the month's latest member close (ascending; a date may lie past the
   * grid — an open month closing after the plan tail).
   */
  cc_facturacion_bars?: (CcFacturadoBarSegments & { as_of_date: string })[];
  /** Σ of account `deposits_acum` per day (`__group_dep_total` line). */
  deposits_acum_total?: number[];
  /** Agrupado lines (bucket sums keyed by the monthly grouped block's synthetic ids). */
  grouped_accounts?: DailySeriesAccountLineDto[];
  /** "Sin agrupar" bucket lines, keyed by the monthly ungrouped block's synthetic ids
   * (one nav level deeper; only emitted when they differ from `grouped_accounts`). */
  ungrouped_accounts?: DailySeriesAccountLineDto[];
  /**
   * Chart-host overlays (Pasivos «Disponible»/«Disponible total», Efectivo «Tarjeta de
   * crédito»), index-aligned with points. Values only — name/color/reference styling come
   * from the monthly block's matching `lines` entry.
   */
  reference_lines?: { dataKey: string; values: (number | null)[] }[];
  /**
   * Mirror of the monthly block's `chart_end_ymd`: set when every account line ends before
   * the grid does (all sold out). The valuation chart trims points past it so the axis stops
   * at the last visible day; `points` stay full-length for the P/L bars and detalle table.
   */
  chart_end_ymd?: string;
}
