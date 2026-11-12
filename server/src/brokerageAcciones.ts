/** Legacy aggregate account from excel import — excluded from APIs and charts. */
export const NOTE_STOCKS_LEGACY = "import:excel|key=stocks";

/**
 * The pesos the structural rules read whatever the display unit — which accounts were liquidated,
 * which value-map tiles are hidden and their order, whether a unit could not convert a row — so
 * a row means the same thing in every unit. Server-only: never sent.
 */
export type DashboardRowClpBasis = {
  current_value: number | null;
  deposits: number;
  delta_total: number | null;
};

/**
 * One account's dashboard row. Every money field is in the listing's display unit (the request's
 * `unit`); pesos are the ledger's own unit, so in CLP no value is missing.
 */
export interface DashboardAccountStats {
  account_id: number;
  name: string;
  group_slug: string;
  group_label: string;
  bucket_slug: string;
  bucket_label: string;
  /** Top-level NW dashboard bucket from asset_groups ancestry. */
  dashboard_bucket_slug: string;
  /** Lifetime net deposits (null: the unit has no rate for them). */
  deposits: number | null;
  /** Nominal P/L for the current calendar month (or latest month in series). */
  delta_month?: number | null;
  /** Sum of nominal P/L in the current calendar year. */
  delta_year?: number | null;
  /** Cumulative nominal P/L through the latest performance month. */
  delta_total?: number | null;
  deposits_month?: number | null;
  deposits_year?: number | null;
  /** Day window = (yesterday, Chile today]; see dashboardAccounts.ts. */
  deposits_day?: number | null;
  /** Balance change vs yesterday's close net of day deposits. */
  delta_day?: number | null;
  /** Account mark yesterday (the day window anchor). */
  prior_day_close?: number | null;
  /** Month-end close for the calendar month before Chile today. */
  prior_month_close?: number | null;
  /** Close for the last day of the prior calendar year. */
  prior_year_close?: number | null;
  current_value: number | null;
  valuation_as_of: string | null;
  /** The unit could not resolve a rate for the balance or the deposits. */
  fx_missing?: boolean;
  /** Leaf kind slug (e.g. cuenta_corriente, fondo_reserva) — client filters on it. */
  category_slug?: string;
  /** 1 = omitted from group/bucket totals (still listed). */
  exclude_from_group_totals?: number | null;
  notes: string | null;
  /**
   * True when monthly closing values end with more than three trailing zero months (same tail rule as
   * valuation charts). Computed on each `/api/dashboard` response.
   */
  chart_inactive: boolean;
  /** SPY, VEA, BTC, ETH — ticker, units, value per unit in the row's unit when data exists (`accountPositionInUnit.ts`). */
  position?: {
    ticker: string;
    units_kind: "shares" | "coin" | "contracts";
    units: number | null;
    unit: string;
    deposited: number | null;
    value: number | null;
    value_as_of: string | null;
    value_per_unit: number | null;
    dividends?: number;
    total_return?: number | null;
    return_on_deposited_pct?: number | null;
  } | null;
  /** True when any linked global sync source is currently stale. */
  sync_stale: boolean;
  /** Flow-adjusted period returns in the unit (ratios, compounded daily). */
  pct_day?: number | null;
  pct_month?: number | null;
  pct_year?: number | null;
  pct_total?: number | null;
  /** The one-step Total: P/L acumulado ÷ net deposits (`pct_total` compounds daily). */
  pct_total_on_deposits?: number | null;
  has_period_returns?: boolean;
  loan_account_id?: number | null;
  /** Server-only: see {@link DashboardRowClpBasis}. */
  clp_basis: DashboardRowClpBasis;
}
