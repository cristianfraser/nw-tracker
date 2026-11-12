/** How a row entered the system (not where the API read it from). */
export type DataOrigin = "import_document" | "manual" | "api_sync";

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

/** What an account holds a quantity of: shares, coins, or (signed) option contracts. */
export type UnitsKind = "shares" | "coin" | "contracts";

export interface AccountPositionSnapshot {
  ticker: string;
  units_kind: UnitsKind;
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

/** One rate pair (`base` priced in `quote`) a conversion into the display unit walks. */
export interface FxCoveragePair {
  base: string;
  quote: string;
  complete: boolean;
  first_missing_date: string | null;
  missing_count: number;
  fx_min: string | null;
  fx_max: string | null;
  daily_count: number;
  row_count: number;
  is_sparse: boolean;
  max_gap_days: number;
}

/** Whether the stored rates cover every pair a conversion into `unit` walks. */
export interface FxCoverage {
  unit: DisplayUnitCode;
  pairs: FxCoveragePair[];
  complete: boolean;
  first_missing_date: string | null;
  missing_count: number;
  is_sparse: boolean;
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

/**
 * A display unit: a lowercase currency code the server loads (`currencies`, core tier: clp, usd,
 * eur, …) or `uf` where a surface accepts it. Data, not a closed union.
 */
export type DisplayUnitCode = string;

/** One loaded currency (`GET /api/currencies`). */
export interface CurrencyDto {
  code: string;
  symbol: string;
  minor_digits: number;
  /** `core`: a display unit, kept current; `on_demand`: loaded when something holds it. */
  tier: string;
}

export interface CurrenciesResponse {
  currencies: CurrencyDto[];
}
