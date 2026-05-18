/** Legacy aggregate account from excel import — excluded from APIs and charts. */
export const NOTE_STOCKS_LEGACY = "import:excel|key=stocks";

export interface DashboardAccountStats {
  account_id: number;
  name: string;
  group_slug: string;
  group_label: string;
  category_slug: string;
  category_label: string;
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
  current_value_clp: number | null;
  valuation_as_of: string | null;
  current_value_usd: number | null;
  fx_clp_per_usd: number | null;
  fx_date_used: string | null;
  notes: string | null;
  /** SPY, VEA, BTC, ETH — ticker, units, implied CLP per unit when data exists */
  position?: {
    ticker: string;
    units_kind: "shares" | "coin";
    units: number | null;
    deposited_clp: number;
    value_clp: number | null;
    value_as_of: string | null;
    value_per_unit_clp: number | null;
  } | null;
}
