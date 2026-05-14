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
