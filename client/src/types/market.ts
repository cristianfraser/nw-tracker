import type { FxCoverage } from "./core";

/** `GET /api/dashboard/stocks-earnings-monthly` — merged SPY+VEA (or single), derived. */
export interface StocksLifetimeEarningsResponse {
  unit: "clp" | "usd" | "uf";
  stock_accounts: { account_id: number; name: string }[];
  points: { as_of_date: string; delta_month: number; accumulated_earnings: number; ytd_merged: number }[];
}

/** `GET /api/market-series` — sparse observations per field (no cross-series forward-fill); CLP crosses use FX on or before each equity/fund observation date. */
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
  fx_usd_clp: { date: string; value: number }[];
  fx_usd_clp_bcentral: { date: string; value: number }[];
  fx_usd_clp_buy?: { date: string; value: number }[];
  fx_usd_clp_sell?: { date: string; value: number }[];
  eur_clp: { date: string; value: number }[];
  fx_coverage: FxCoverage;
}

/** `GET /api/market-ticker` — Chile-today snapshot for the marquee (not forward-filled series tail). */
export interface MarketDisplaySeriesRow {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: "equity" | "fund_unit" | "fx_usd" | "uf" | "composite";
  series_key: string | null;
  show_in_marquee: number;
  show_in_rates: number;
  rates_chart_title: string | null;
  source: "builtin" | "account" | "manual";
}

export interface WatchlistChanges {
  day_pct: number | null;
  week_pct: number | null;
  mtd_pct: number | null;
  mom_pct: number | null;
  ytd_pct: number | null;
  yoy_pct: number | null;
  y3_pct: number | null;
  y5_pct: number | null;
  y10_pct: number | null;
}

export interface WatchlistCompositeHoldingRow {
  ticker: string;
  weight: number;
  value: number | null;
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
}

export interface WatchlistRow extends MarketDisplaySeriesRow {
  value: number | null;
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
  composite_holdings?: WatchlistCompositeHoldingRow[];
}

export interface WatchlistResponse {
  app: WatchlistRow[];
  manual: WatchlistRow[];
}

export interface MarketTickerResponse {
  chile_today: string;
  uf: { date: string; clp_per_uf: number } | null;
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  risky_norris: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  risky_norris_proxy: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  equities: {
    ticker: string;
    trade_date: string;
    value: number;
    /** Exchange quote currency for `value` (CLP for Bolsa de Santiago tickers). */
    currency: "usd" | "clp";
    delta_pct: number | null;
    source?: "live" | "eod";
  }[];
  marquee_series?: MarketDisplaySeriesRow[];
}

export interface RatesInstrumentsResponse {
  instruments: MarketDisplaySeriesRow[];
}
