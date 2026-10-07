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
  /** Long trailing-zero tail; hidden from nav child cards, kept in group charts/tables. */
  chart_inactive?: boolean;
}

export interface AccountPositionSnapshot {
  ticker: string;
  units_kind: "shares" | "coin";
  units: number | null;
  deposited_clp: number;
  value_clp: number | null;
  value_as_of: string | null;
  value_per_unit_clp: number | null;
  /** Total dividends received (DRIP + payouts), informational — already netted into total return. */
  dividends_clp?: number;
  total_return_clp?: number | null;
  return_on_deposited_pct?: number | null;
  /** Stock accounts: the shares split by the cash account that paid for them (one account per ticker, any broker). */
  brokers?: EquityBrokerHolding[];
}

export interface EquityBrokerHolding {
  cash_account_id: number | null;
  cash_account_name: string | null;
  units: number;
  share: number;
  value_clp: number | null;
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
