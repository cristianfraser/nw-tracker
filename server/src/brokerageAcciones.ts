/** Legacy aggregate account from excel import — excluded from APIs and charts. */
export const NOTE_STOCKS_LEGACY = "import:excel|key=stocks";

export interface DashboardAccountStats {
  account_id: number;
  name: string;
  group_slug: string;
  group_label: string;
  bucket_slug: string;
  bucket_label: string;
  /** Top-level NW dashboard bucket from asset_groups ancestry. */
  dashboard_bucket_slug: string;
  deposits_clp: number;
  deposits_usd?: number | null;
  /** Nominal P/L for the current calendar month (or latest month in series). */
  delta_month_clp?: number | null;
  delta_month_usd?: number | null;
  /** Sum of nominal P/L in the current calendar year. */
  delta_year_clp?: number | null;
  delta_year_usd?: number | null;
  /** Cumulative nominal P/L through the latest performance month. */
  delta_total_clp?: number | null;
  delta_total_usd?: number | null;
  deposits_month_clp?: number;
  deposits_month_usd?: number | null;
  deposits_year_clp?: number;
  deposits_year_usd?: number | null;
  /** Day window = (prior completed NYSE session, Chile today]; see dashboardAccounts.ts. */
  deposits_day_clp?: number;
  deposits_day_usd?: number | null;
  /** Balance change vs prior-session close net of day deposits (null for CC/mortgage). */
  delta_day_clp?: number | null;
  delta_day_usd?: number | null;
  /** Account mark at the prior completed NYSE session (the day window anchor). */
  prior_day_close_clp?: number | null;
  prior_day_close_usd?: number | null;
  /** Performance series month-end close for the calendar month before Chile today. */
  prior_month_close_clp?: number | null;
  prior_month_close_usd?: number | null;
  /** Performance series close for the latest month in the prior calendar year. */
  prior_year_close_clp?: number | null;
  prior_year_close_usd?: number | null;
  current_value_clp: number | null;
  valuation_as_of: string | null;
  current_value_usd: number | null;
  fx_clp_per_usd: number | null;
  fx_date_used: string | null;
  /** USD display could not resolve FX for balance or deposits. */
  fx_missing?: boolean;
  /** Leaf kind slug (e.g. cuenta_corriente, cash_savings shortfall) — client filters on it. */
  category_slug?: string;
  /** 1 = omitted from group/bucket totals (still listed). */
  exclude_from_group_totals?: number | null;
  notes: string | null;
  /**
   * True when monthly closing values end with more than three trailing zero months (same tail rule as
   * valuation charts). Computed on each `/api/dashboard` response.
   */
  chart_inactive: boolean;
  /** SPY, VEA, BTC, ETH — ticker, units, implied CLP per unit when data exists */
  position?: {
    ticker: string;
    units_kind: "shares" | "coin";
    units: number | null;
    deposited_clp: number;
    value_clp: number | null;
    value_as_of: string | null;
    value_per_unit_clp: number | null;
    dividends_clp?: number;
    total_return_clp?: number | null;
    return_on_deposited_pct?: number | null;
  } | null;
  /** True when any linked global sync source is currently stale. */
  sync_stale: boolean;
}
